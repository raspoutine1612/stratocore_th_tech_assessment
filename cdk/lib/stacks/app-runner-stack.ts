import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { PROJECT_PREFIX } from '../constants';
import { AppRunnerApi } from '../app/app-runner-api';

/**
 * AppRunnerStack — App Runner compute target.
 *
 * Reads all identifiers from SSM (written by SharedStack).
 * No VPC or ALB dependencies — App Runner manages its own networking.
 */
export class AppRunnerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const p = `/${PROJECT_PREFIX}`;

    const bucketName = ssm.StringParameter.valueForStringParameter(this, `${p}/bucket-name`);
    const bucketArn = ssm.StringParameter.valueForStringParameter(this, `${p}/bucket-arn`);
    const bucketKmsKeyArn = ssm.StringParameter.valueForStringParameter(this, `${p}/bucket-kms-key-arn`);
    const tableName = ssm.StringParameter.valueForStringParameter(this, `${p}/dynamo-table-name`);
    const tableArn = ssm.StringParameter.valueForStringParameter(this, `${p}/dynamo-table-arn`);
    const tableKmsKeyArn = ssm.StringParameter.valueForStringParameter(this, `${p}/dynamo-kms-key-arn`);
    const ecrRepoUri = ssm.StringParameter.valueForStringParameter(this, `${p}/ecr-repo-uri`);

    const api = new AppRunnerApi(this, 'AppRunnerApi', {
      imageUri: `${ecrRepoUri}:latest`,
      bucketName,
      bucketArn,
      bucketKmsKeyArn,
      tableName,
      tableArn,
      tableKmsKeyArn,
      awsRegion: this.region,
    });

    new ssm.StringParameter(this, 'AppRunnerServiceArn', {
      parameterName: `/${PROJECT_PREFIX}/app-runner-service-arn`,
      stringValue: api.serviceArn,
    });

    new cdk.CfnOutput(this, 'ServiceUrl', {
      value: `https://${api.serviceUrl}`,
      description: 'App Runner service endpoint',
    });
  }
}
