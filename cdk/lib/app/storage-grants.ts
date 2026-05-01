import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface StorageGrantProps {
  /** ARN of the S3 bucket. */
  readonly bucketArn: string;
  /** ARN of the KMS key used to encrypt the S3 bucket. */
  readonly bucketKmsKeyArn: string;
  /** ARN of the DynamoDB table. */
  readonly tableArn: string;
  /** ARN of the KMS key used to encrypt the DynamoDB table. */
  readonly tableKmsKeyArn: string;
}

/**
 * Grant the minimum storage permissions required by the file API to a principal.
 *
 * S3:  PutObject, GetObject, DeleteObject (scoped to bucket objects)
 *      ListBucket (scoped to the bucket itself)
 *      KMS EncryptDecrypt on the bucket key
 *
 * DynamoDB: GetItem (read-only — authentication only, no writes from the app)
 *           KMS Decrypt on the table key
 *
 * The `id` parameter is used as a CDK construct ID prefix, which prevents
 * node ID collisions when the function is called multiple times in the same scope.
 *
 * Used by both EcsApi and LambdaApi so that grants stay in sync between targets.
 */
export function grantStorageAccess(
  scope: Construct,
  id: string,
  grantee: iam.IGrantable,
  props: StorageGrantProps,
): void {
  // A dedicated sub-construct scopes all imported resources under a unique node path,
  // preventing ID collisions if this function is called more than once per scope.
  const sub = new Construct(scope, id);

  // S3 grants — fromBucketAttributes returns IBucket with no grant() method,
  // so we use iam.Grant.addToPrincipal for exact action scoping.
  const bucketKey = kms.Key.fromKeyArn(sub, 'BucketKey', props.bucketKmsKeyArn);

  iam.Grant.addToPrincipal({
    grantee,
    actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
    resourceArns: [`${props.bucketArn}/*`],
  });
  iam.Grant.addToPrincipal({
    grantee,
    actions: ['s3:ListBucket'],
    resourceArns: [props.bucketArn],
  });
  bucketKey.grantEncryptDecrypt(grantee);

  // DynamoDB grants — ITable has grant(), no raw PolicyStatement needed.
  const tableKey = kms.Key.fromKeyArn(sub, 'TableKey', props.tableKmsKeyArn);
  const table = dynamodb.Table.fromTableAttributes(sub, 'Table', {
    tableArn: props.tableArn,
    encryptionKey: tableKey,
  });
  table.grant(grantee, 'dynamodb:GetItem');
  tableKey.grantDecrypt(grantee);
}
