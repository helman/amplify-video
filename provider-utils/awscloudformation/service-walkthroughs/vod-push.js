const inquirer = require('inquirer');
const fs = require('fs-extra');
const path = require('path');
const ejs = require('ejs');
const chalk = require('chalk');
const question = require('../../vod-questions.json');
const { getAWSConfig } = require('../utils/get-aws');
const { generateIAMAdmin, generateIAMAdminPolicy } = require('./vod-roles');

module.exports = {
  serviceQuestions,
};

async function serviceQuestions(context, options, defaultValuesFilename, resourceName) {
  const { amplify } = context;
  const provider = getAWSConfig(context, options);
  const aws = await provider.getConfiguredAWSClient(context);
  const projectMeta = context.amplify.getProjectMeta();
  const projectDetails = context.amplify.getProjectDetails();
  const defaultLocation = path.resolve(`${__dirname}/../default-values/${defaultValuesFilename}`);
  const defaults = JSON.parse(fs.readFileSync(`${defaultLocation}`));
  const props = {};
  let nameDict = {};

  const { inputs } = question.video;
  const nameProject = [
    {
      type: inputs[0].type,
      name: inputs[0].key,
      message: inputs[0].question,
      validate: amplify.inputValidation(inputs[0]),
      default: amplify.getProjectDetails().projectConfig.projectName,
    }];

  if (resourceName) {
    nameDict.resourceName = resourceName;
    props.shared = nameDict;
  } else {
    nameDict = await inquirer.prompt(nameProject);
    props.shared = nameDict;
    const uuid = Math.random().toString(36).substring(2, 6)
                + Math.random().toString(36).substring(2, 6);
    props.shared.bucketInput = `${nameDict.resourceName.toLowerCase()}-${projectDetails.localEnvInfo.envName}-i${uuid}`.slice(0, 63);
    props.shared.bucketOutput = `${nameDict.resourceName.toLowerCase()}-${projectDetails.localEnvInfo.envName}-o${uuid}`.slice(0, 63);
  }

  props.shared.bucket = projectMeta.providers.awscloudformation.DeploymentBucketName;

  let jobTemplate = {};
  props.template = {};
  while (!('JobTemplate' in jobTemplate)) {
    const pluginDir = path.join(`${__dirname}/..`);
    const templates = fs.readdirSync(`${pluginDir}/templates/`);
    const availableTemplates = [];
    let mcClient = new aws.MediaConvert();

    templates.forEach((filepath) => {
      const templateInfo = JSON.parse(fs.readFileSync(`${pluginDir}/templates/${filepath}`));
      availableTemplates.push({
        name: templateInfo.Description,
        value: filepath,
      });
    });

    availableTemplates.push({
      name: 'Bring your own template',
      value: 'advanced',
    });
    const templateQuestion = [
      {
        type: inputs[1].type,
        name: inputs[1].key,
        message: inputs[1].question,
        choices: availableTemplates,
      },
    ];
    const template = await inquirer.prompt(templateQuestion);

    try {
      const endpoints = await mcClient.describeEndpoints().promise();
      aws.config.mediaconvert = { endpoint: endpoints.Endpoints[0].Url };
      // Override so config applies
      mcClient = new aws.MediaConvert();
    } catch (e) {
      console.log(chalk.red(e.message));
    }

    if (template.encodingTemplate === 'advanced') {
      const encodingTemplateName = [
        {
          type: inputs[2].type,
          name: inputs[2].key,
          message: inputs[2].question,
          validate: amplify.inputValidation(inputs[2]),
        },
      ];
      const advTemplate = await inquirer.prompt(encodingTemplateName);
      props.template.name = advTemplate.encodingTemplate;
      const params = {
        Name: props.template.name,
      };

      try {
        jobTemplate = await mcClient.getJobTemplate(params).promise();
      } catch (e) {
        console.log(chalk.red(e.message));
      }
    } else {
      const templateInfo = JSON.parse(fs.readFileSync(`${pluginDir}/templates/${template.encodingTemplate}`));
      props.template.name = template.encodingTemplate;

      try {
        jobTemplate = await mcClient.createJobTemplate(templateInfo).promise();
      } catch (e) {
        console.log(chalk.red(e.message));
      }
    }
  }

  props.template.arn = jobTemplate.JobTemplate.Arn;

  // prompt for cdn
  props.contentDeliveryNetwork = {};
  // const cdnEnable = [
  //   {
  //     type: inputs[3].type,
  //     name: inputs[3].key,
  //     message: inputs[3].question,
  //     validate: amplify.inputValidation(inputs[3]),
  //     default: defaults.contentDeliveryNetwork[inputs[3].key],
  //   }];
  //
  // const cdnResponse = await inquirer.prompt(cdnEnable);

  props.contentDeliveryNetwork.enableDistribution = false;

  const cmsEnable = [
    {
      type: inputs[4].type,
      name: inputs[4].key,
      message: inputs[4].question,
      validate: amplify.inputValidation(inputs[4]),
      default: defaults.contentManagementSystem[inputs[4].key],
    }];

  const cmsResponse = await inquirer.prompt(cmsEnable);

  if (cmsResponse.enableCMS) {
    let apiName = getAPIName(context);
    if (apiName === '') {
      context.print.warning('Video On Demand only supports GraphQL right now.');
      context.print.warning('If you want to only use API for CMS then choose the default ToDo and don\'t edit it until later.');
      const apiPlugin = amplify.getPluginInstance(context, 'api');
      context.input.command = 'add';
      await apiPlugin.executeAmplifyCommand(context);
      apiName = getAPIName(context);
    } else {
      context.print.info(`Using ${apiName} to manage API`);
    }

    await createCMS(context, apiName, props);
  }

  props.parameters = {
    authRoleName: {
      Ref: 'AuthRoleName',
    },
    unauthRoleName: {
      Ref: 'UnauthRoleName',
    },
  };

  return props;
}

async function createCMS(context, apiName, props) {
  const { inputs } = question.video;
  const cmsEdit = [
    {
      type: inputs[6].type,
      name: inputs[6].key,
      message: inputs[6].question,
      default: true,
    }];
  const backEndDir = context.amplify.pathManager.getBackendDirPath();
  const resourceDir = path.normalize(path.join(backEndDir, 'api', apiName));
  let authConfig = {};
  const amplifyMeta = context.amplify.getProjectMeta();
  if ('api' in amplifyMeta && Object.keys(amplifyMeta.api).length !== 0) {
    Object.values(amplifyMeta.api).forEach((project) => {
      if ('output' in project) {
        ({ authConfig } = project.output);
      }
    });
  }

  const parameters = JSON.parse(fs.readFileSync(`${resourceDir}/parameters.json`));
  const cmsEditResponse = await inquirer.prompt(cmsEdit);
  const editSchemaChoice = cmsEditResponse.editAPI;

  props.cms = cmsEditResponse;

  await writeNewModel(resourceDir, props);

  if (editSchemaChoice) {
    await context.amplify.openEditor(context, `${resourceDir}/schema.graphql`).then(async () => {
      let notCompiled = true;
      while (notCompiled) {
        notCompiled = await compileSchema(context, resourceDir, parameters, authConfig);
      }
    });
  } else {
    await compileSchema(context, resourceDir, parameters, authConfig);
  }

  authGroupHack(context, props.shared.bucketInput);
}

async function writeNewModel(resourceDir, props) {
  const appendSchemaTemplate = await fs.readFileSync(`${__dirname}/../schemas/schema.graphql.ejs`, { encoding: 'utf-8' });

  const appendSchema = ejs.render(appendSchemaTemplate, props);

  await fs.appendFileSync(`${resourceDir}/schema.graphql`, appendSchema);
}

async function compileSchema(context, resourceDir, parameters, authConfig) {
  try {
    await context.amplify.executeProviderUtils(
      context,
      'awscloudformation',
      'compileSchema',
      { resourceDir, parameters, authConfig },
    );
    return false;
  } catch (e) {
    context.print.error('Failed compiling GraphQL schema:');
    context.print.info(e.message);
    const continueQuestion = {
      type: 'input',
      name: 'pressKey',
      message: `Correct the errors in schema.graphql and press Enter to re-compile.\n\nPath to schema.graphql:\n${resourceDir}/schema.graphql`,
    };
    await inquirer.prompt(continueQuestion);
    return true;
  }
}

function getAPIName(context) {
  const { amplifyMeta } = context.amplify.getProjectDetails();
  let apiName = '';

  if (amplifyMeta.api) {
    const categoryResources = amplifyMeta.api;
    Object.keys(categoryResources).forEach((resource) => {
      if (categoryResources[resource].service === 'AppSync') {
        apiName = resource;
      }
    });
  }
  return apiName;
}

async function authGroupHack(context, bucketName) {
  const userPoolGroupFile = path.join(
    context.amplify.pathManager.getBackendDirPath(),
    'auth',
    'userPoolGroups',
    'user-pool-group-precedence.json',
  );

  const amplifyMeta = context.amplify.getProjectMeta();

  if (!('auth' in amplifyMeta) || Object.keys(amplifyMeta.auth).length === 0) {
    context.print.error('You have no auth projects. Moving on.');
    return;
  }

  let resourceName = '';

  Object.keys(amplifyMeta.auth).forEach((authCategory) => {
    if (amplifyMeta.auth[authCategory].service === 'Cognito') {
      resourceName = authCategory;
    }
  });

  if (fs.existsSync(userPoolGroupFile)) {
    const userPoolGroup = JSON.parse(fs.readFileSync(userPoolGroupFile));
    if (userPoolGroup.length === 0) {
      userPoolGroup.push(generateIAMAdmin(resourceName, bucketName));
    } else {
      userPoolGroup.forEach((userGroup, index) => {
        if (userGroup.groupName === 'Admin') {
          if (!('customPolicies' in userGroup)) {
            userGroup.customPolicies = [];
          }
          const policy = generateIAMAdminPolicy(resourceName, bucketName);
          userGroup.customPolicies.push(policy);
          return;
        }
        if (userPoolGroup.length === index + 1) {
          userPoolGroup.push(generateIAMAdmin(resourceName, bucketName));
        }
      });
    }
    await createUserPoolGroups(context, resourceName, userPoolGroup);
  } else {
    const admin = generateIAMAdmin(resourceName, bucketName);
    const userPoolGroupList = [admin];
    await createUserPoolGroups(context, resourceName, userPoolGroupList);
  }
}

async function createUserPoolGroups(context, resourceName, userPoolGroupList) {
  if (userPoolGroupList && userPoolGroupList.length > 0) {
    const userPoolGroupFile = path.join(
      context.amplify.pathManager.getBackendDirPath(),
      'auth',
      'userPoolGroups',
      'user-pool-group-precedence.json',
    );

    const userPoolGroupParams = path.join(context.amplify.pathManager.getBackendDirPath(), 'auth', 'userPoolGroups', 'parameters.json');

    /* eslint-disable */
    const groupParams = {
      AuthRoleArn: {
        'Fn::GetAtt': ['AuthRole', 'Arn'],
      },
      UnauthRoleArn: {
        'Fn::GetAtt': ['UnauthRole', 'Arn'],
      },
    };
    /* eslint-enable */

    fs.outputFileSync(userPoolGroupParams, JSON.stringify(groupParams, null, 4));
    fs.outputFileSync(userPoolGroupFile, JSON.stringify(userPoolGroupList, null, 4));

    context.amplify.updateamplifyMetaAfterResourceAdd('auth', 'userPoolGroups', {
      service: 'Cognito-UserPool-Groups',
      providerPlugin: 'awscloudformation',
      dependsOn: [
        {
          category: 'auth',
          resourceName,
          attributes: ['UserPoolId', 'AppClientIDWeb', 'AppClientID', 'IdentityPoolId'],
        },
      ],
    });
  }
}