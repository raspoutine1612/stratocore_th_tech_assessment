import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { PROJECT_PREFIX } from '../constants';
import { FileStorage } from '../app/file-storage';
import { EcrRepository } from '../constructs/compute/ecr-repository';

/**
 * SharedStack — durable shared resources.
 *
 * SSM parameters written (prefix: /file-api):
 * - /file-api/aws-region
 * - /file-api/bucket-name
 * - /file-api/bucket-arn
 * - /file-api/bucket-kms-key-arn
 * - /file-api/dynamo-table-name
 * - /file-api/dynamo-table-arn
 * - /file-api/dynamo-kms-key-arn
 * - /file-api/ecr-repo-uri
 * - /file-api/ecr-repo-arn
 */
export class SharedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const storage = new FileStorage(this, 'Storage');
    const ecr = new EcrRepository(this, 'Ecr');

    // Optional: grant a specific IAM principal full access for demo/admin use.
    // Pass via: --context adminArn=arn:aws:iam::ACCOUNT:user/USERNAME
    const adminArn = this.node.tryGetContext('adminArn') as string | undefined;
    if (adminArn) {
      storage.grantAdminAccess(new iam.ArnPrincipal(adminArn));
    }

    new ssm.StringParameter(this, 'AwsRegion', {
      parameterName: `/${PROJECT_PREFIX}/aws-region`,
      stringValue: this.region,
    });
    new ssm.StringParameter(this, 'BucketName', {
      parameterName: `/${PROJECT_PREFIX}/bucket-name`,
      stringValue: storage.bucket.bucket.bucketName,
    });
    new ssm.StringParameter(this, 'BucketArn', {
      parameterName: `/${PROJECT_PREFIX}/bucket-arn`,
      stringValue: storage.bucket.bucket.bucketArn,
    });
    new ssm.StringParameter(this, 'BucketKmsKeyArn', {
      parameterName: `/${PROJECT_PREFIX}/bucket-kms-key-arn`,
      stringValue: storage.bucketKey.key.keyArn,
    });
    new ssm.StringParameter(this, 'DynamoTableName', {
      parameterName: `/${PROJECT_PREFIX}/dynamo-table-name`,
      stringValue: storage.table.table.tableName,
    });
    new ssm.StringParameter(this, 'DynamoTableArn', {
      parameterName: `/${PROJECT_PREFIX}/dynamo-table-arn`,
      stringValue: storage.table.table.tableArn,
    });
    new ssm.StringParameter(this, 'DynamoKmsKeyArn', {
      parameterName: `/${PROJECT_PREFIX}/dynamo-kms-key-arn`,
      stringValue: storage.tableKey.key.keyArn,
    });
    new ssm.StringParameter(this, 'EcrRepoUri', {
      parameterName: `/${PROJECT_PREFIX}/ecr-repo-uri`,
      stringValue: ecr.repository.repositoryUri,
    });
    new ssm.StringParameter(this, 'EcrRepoArn', {
      parameterName: `/${PROJECT_PREFIX}/ecr-repo-arn`,
      stringValue: ecr.repository.repositoryArn,
    });
    new ssm.StringParameter(this, 'EcrRepoName', {
      parameterName: `/${PROJECT_PREFIX}/ecr-repo-name`,
      stringValue: ecr.repository.repositoryName,
    });
  }
}
