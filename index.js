const fs = require('fs');
const Hapi = require('hapi');
const { graphqlHapi, graphiqlHapi } = require('apollo-server-hapi');
const path = require('path');
const { validateSchema, printError, parse, buildASTSchema } = require('graphql');
const getConfig = require('./get-config');
const { makeExecutableSchema } = require('graphql-tools');

const MIGRATION_DOCS = 'https://github.com/sid88in/serverless-appsync-plugin/blob/master/README.md#cfn-migration';

class ServerlessAppsyncPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = this.serverless.getProvider('aws');
    this.commands = {
      'delete-appsync': {
        usage: 'Helps you delete AppSync API',
        lifecycleEvents: ['delete'],
      },
      'deploy-appsync': {
        usage: 'DEPRECATED: Helps you deploy AppSync API',
        lifecycleEvents: ['deploy'],
      },
      'update-appsync': {
        usage: 'DEPRECATED: Helps you update AppSync API',
        lifecycleEvents: ['update'],
      },
      // TODO: this conflicts with serverless offline
      'offline': {
        usage: 'Allows you to run App Sync Offline',
        lifecycleEvents: ['offline'],
      }
    };

    const generateMigrationErrorMessage = command => () => {
      throw new this.serverless.classes.Error(`serverless-appsync: ${command} `
        + `is no longer supported. See ${MIGRATION_DOCS} for more information`);
    };
    this.hooks = {
      'before:deploy:initialize': () => this.validateSchema(),
      'delete-appsync:delete': () => this.deleteGraphQLEndpoint(),
      'deploy-appsync:deploy': generateMigrationErrorMessage('deploy-appsync'),
      'update-appsync:update': generateMigrationErrorMessage('update-appsync'),
      'before:deploy:deploy': () => this.addResources(),
      'offline:offline': () => this.offline(),
    };
  }

  loadConfig() {
    return getConfig(
      this.serverless.service.custom.appSync,
      this.serverless.service.provider,
      this.serverless.config.servicePath,
    );
  }

  validateSchema() {
    const { schema } = this.loadConfig();
    const ast = buildASTSchema(parse(schema));
    const errors = validateSchema(ast);
    if (!errors.length) {
      return;
    }

    errors.forEach((error) => {
      this.serverless.cli.log(printError(error));
    });
    throw new this.serverless.classes.Error('Cannot proceed invalid graphql SDL');
  }

  offline() {
    this.serverless.cli.log('Starting offline');

    // TODO: validate schema
    // TODO: fetch the resolvers

    process.env.IS_OFFLINE = true;

    return Promise.resolve(this._createServer())
    .then(() => this._listen())
    .then(() => this._listenForSigInt())
    .then(() => this.end())
    .catch(e => console.error(e));
  }

  _createServer() {
    this.server = new Hapi.server({
      // TODO from CLI options
      host: 'localhost',
      port: 7000,
    });

    this.server.register({
      plugin: graphiqlHapi,
      options: {
        path: '/graphiql',
        graphiqlOptions: {
          endpointURL: '/graphql'
        },
      },
    })

    const config = this.loadConfig();

    this.server.register({
      plugin: graphqlHapi,
      options: {
        path: '/graphql',
        graphqlOptions: {
          schema: makeExecutableSchema({typeDefs: config.schema}),
        },
        route: {
          cors: true,
        },
      },
    })

    return this.server;
  }

  _listen() {
    console.log('listening')
    return this.server.start();
  }

  _listenForSigInt() {
    // Listen for ctrl+c to stop the server
    return new Promise(resolve => {
      process.on('SIGINT', () => {
        this.serverless.cli.log('Offline Halting...');
        resolve();
      });
    });
  }

  end() {
    this.serverless.cli.log('Halting offline server');
    this.server.stop({ timeout: 5000 })
      .then(() => process.exit(this.exitCode));
  }

  deleteGraphQLEndpoint() {
    const config = this.loadConfig();
    const { apiId } = config;
    if (!apiId) {
      throw new this.serverless.classes.Error('serverless-appsync: no apiId is defined. If you are not '
        + `migrating from a previous version of the plugin this is expected.  See ${MIGRATION_DOCS} '
        + 'for more information`);
    }

    this.serverless.cli.log('Deleting GraphQL Endpoint...');
    return this.provider
      .request('AppSync', 'deleteGraphqlApi', {
        apiId,
      })
      .then((data) => {
        if (data) {
          this.serverless.cli.log(`Successfully deleted GraphQL Endpoint: ${apiId}`);
        }
      });
  }

  addResources() {
    const config = this.loadConfig();

    if (config.apiId) {
      this.serverless.cli.log('WARNING: serverless-appsync has been updated in a breaking way and your '
        + 'service is configured using a reference to an existing apiKey in '
        + '`custom.appSync` which is used in the legacy deploy scripts. This deploy will create '
        + `new graphql resources and WILL NOT update your existing api. See ${MIGRATION_DOCS} for `
        + 'more information');
    }

    const resources = this.serverless.service.provider.compiledCloudFormationTemplate.Resources;
    Object.assign(resources, this.getGraphQlApiEndpointResource(config));
    Object.assign(resources, this.getApiKeyResources(config));
    Object.assign(resources, this.getGraphQLSchemaResource(config));
    Object.assign(resources, this.getDataSourceResources(config));
    Object.assign(resources, this.getResolverResources(config));

    const outputs = this.serverless.service.provider.compiledCloudFormationTemplate.Outputs;
    Object.assign(outputs, this.getGraphQlApiOutputs(config));
    Object.assign(outputs, this.getApiKeyOutputs(config));
  }

  getGraphQlApiEndpointResource(config) {
    return {
      GraphQlApi: {
        Type: 'AWS::AppSync::GraphQLApi',
        Properties: {
          Name: config.name,
          AuthenticationType: config.authenticationType,
          UserPoolConfig: config.authenticationType !== 'AMAZON_COGNITO_USER_POOLS' ? undefined : {
            AwsRegion: config.region,
            DefaultAction: config.userPoolConfig.defaultAction,
            UserPoolId: config.userPoolConfig.userPoolId,
          },
          OpenIDConnectConfig: config.authenticationType !== 'OPENID_CONNECT' ? undefined : {
            Issuer: config.openIdConnectConfig.issuer,
            ClientId: config.openIdConnectConfig.clientId,
            IatTTL: config.openIdConnectConfig.iatTTL,
            AuthTTL: config.openIdConnectConfig.authTTL,
          },
          LogConfig: !config.logConfig ? undefined : {
            CloudWatchLogsRoleArn: config.logConfig.loggingRoleArn,
            FieldLogLevel: config.logConfig.level,
          },
        },
      },
    };
  }

  getApiKeyResources(config) {
    if (config.authenticationType !== 'API_KEY') {
      return {};
    }
    return {
      GraphQlApiKeyDefault: {
        Type: 'AWS::AppSync::ApiKey',
        Properties: {
          ApiId: { 'Fn::GetAtt': ['GraphQlApi', 'ApiId'] },
          Description: 'serverless-appsync-plugin: Default',
          Expires: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60),
        },
      },
    };
  }

  getDataSourceResources(config) {
    return config.dataSources.reduce((acc, ds) => {
      const resource = {
        Type: 'AWS::AppSync::DataSource',
        Properties: {
          ApiId: { 'Fn::GetAtt': ['GraphQlApi', 'ApiId'] },
          Name: ds.name,
          Description: ds.description,
          Type: ds.type,
          ServiceRoleArn: ds.type === 'NONE' ? undefined : ds.config.serviceRoleArn,
        },
      };
      if (ds.type === 'AWS_LAMBDA') {
        resource.Properties.LambdaConfig = {
          LambdaFunctionArn: ds.config.lambdaFunctionArn,
        };
      } else if (ds.type === 'AMAZON_DYNAMODB') {
        resource.Properties.DynamoDBConfig = {
          AwsRegion: ds.config.region || config.region,
          TableName: ds.config.tableName,
          UseCallerCredentials: !!ds.config.useCallerCredentials,
        };
      } else if (ds.type === 'AMAZON_ELASTICSEARCH') {
        resource.Properties.ElasticsearchConfig = {
          AwsRegion:ds.config.region || config.region,
          Endpoint: ds.config.endpoint,
        };
      } else if (ds.type !== 'NONE') {
        throw new this.serverless.classes.Error(`Data Source Type not supported: '${ds.type}`);
      }
      return Object.assign({}, acc, { [this.getDataSourceCfnName(ds.name)]: resource });
    }, {});
  }

  getGraphQLSchemaResource(config) {
    return {
      GraphQlSchema: {
        Type: 'AWS::AppSync::GraphQLSchema',
        Properties: {
          Definition: config.schema,
          ApiId: { 'Fn::GetAtt': ['GraphQlApi', 'ApiId'] },
        },
      },
    };
  }

  getResolverResources(config) {
    return config.mappingTemplates.reduce((acc, tpl) => {
      const reqTemplPath = path.join(config.mappingTemplatesLocation, tpl.request);
      const respTemplPath = path.join(config.mappingTemplatesLocation, tpl.response);
      return Object.assign({}, acc, {
        [`GraphQlResolver${this.getCfnName(tpl.type)}${this.getCfnName(tpl.field)}`]: {
          Type: 'AWS::AppSync::Resolver',
          DependsOn: 'GraphQlSchema',
          Properties: {
            ApiId: { 'Fn::GetAtt': ['GraphQlApi', 'ApiId'] },
            TypeName: tpl.type,
            FieldName: tpl.field,
            DataSourceName: { 'Fn::GetAtt': [this.getDataSourceCfnName(tpl.dataSource), 'Name'] },
            RequestMappingTemplate: fs.readFileSync(reqTemplPath, 'utf8'),
            ResponseMappingTemplate: fs.readFileSync(respTemplPath, 'utf8'),
          },
        },
      });
    }, {});
  }

  getGraphQlApiOutputs() {
    return {
      GraphQlApiUrl: {
        Value: { 'Fn::GetAtt': ['GraphQlApi', 'GraphQLUrl'] },
      },
    };
  }

  getApiKeyOutputs(config) {
    if (config.authenticationType !== 'API_KEY') {
      return {};
    }
    return {
      GraphQlApiKeyDefault: {
        Value: { 'Fn::GetAtt': ['GraphQlApiKeyDefault', 'ApiKey'] },
      },
    };
  }

  getCfnName(name) {
    return name.replace(/[^a-zA-Z0-9]/g, '');
  }

  getDataSourceCfnName(name) {
    return `GraphQlDs${this.getCfnName(name)}`;
  }
}

module.exports = ServerlessAppsyncPlugin;
