import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { PROJECT_PREFIX } from '../constants';
import { LambdaApi } from '../app/lambda-api';

/**
 * LambdaStack — serverless compute target.
 *
 * Reads all identifiers from SSM (written by SharedStack).
 * Creates a Lambda + API Gateway HTTP API to replace App Runner.
 * The function runs the same container image as ECS, adapted by Mangum.
 */
export class LambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const p = `/${PROJECT_PREFIX}`;

    const bucketName = ssm.StringParameter.valueForStringParameter(this, `${p}/bucket-name`);
    const bucketArn = ssm.StringParameter.valueForStringParameter(this, `${p}/bucket-arn`);
    const bucketKmsKeyArn = ssm.StringParameter.valueForStringParameter(this, `${p}/bucket-kms-key-arn`);
    const tableName = ssm.StringParameter.valueForStringParameter(this, `${p}/dynamo-table-name`);
    const tableArn = ssm.StringParameter.valueForStringParameter(this, `${p}/dynamo-table-arn`);
    const tableKmsKeyArn = ssm.StringParameter.valueForStringParameter(this, `${p}/dynamo-kms-key-arn`);
    const ecrRepoArn = ssm.StringParameter.valueForStringParameter(this, `${p}/ecr-repo-arn`);
    const ecrRepoName = ssm.StringParameter.valueForStringParameter(this, `${p}/ecr-repo-name`);

    // fromRepositoryArn requires a concrete name when the ARN is a late-bound SSM token.
    // We store the name separately in SSM and use fromRepositoryAttributes instead.
    const ecrRepository = ecr.Repository.fromRepositoryAttributes(this, 'EcrRepository', {
      repositoryArn: ecrRepoArn,
      repositoryName: ecrRepoName,
    });

    const api = new LambdaApi(this, 'LambdaApi', {
      ecrRepository,
      bucketName,
      bucketArn,
      bucketKmsKeyArn,
      tableName,
      tableArn,
      tableKmsKeyArn,
    });

    // Lambda function name is used by the pipeline to update the image after each build.
    new ssm.StringParameter(this, 'LambdaFunctionName', {
      parameterName: `/${PROJECT_PREFIX}/lambda-function-name`,
      stringValue: api.functionName,
      description: 'Lambda function name for the serverless compute target',
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.apiUrl,
      description: 'API Gateway HTTP API endpoint (Lambda serverless target)',
    });
  }
}
