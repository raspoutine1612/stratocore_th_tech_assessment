import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface KmsKeyProps {
  /** Human-readable description of what this key protects. */
  readonly description?: string;
  /**
   * Removal policy for the key.
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: cdk.RemovalPolicy;
}

/**
 * A KMS key with annual rotation and two mandatory resource policy statements:
 *
 * 1. Root admin — without this, losing all grants makes the key permanently unusable.
 * 2. IAM delegation — lets identity policies grant key access; needed for bucket.grant() and table.grant().
 */
export class KmsKey extends Construct {
  /** The underlying CDK KMS key. Pass this to storage or observability constructs. */
  public readonly key: kms.Key;

  constructor(scope: Construct, id: string, props: KmsKeyProps = {}) {
    super(scope, id);

    this.key = new kms.Key(this, 'Key', {
      description: props.description,
      enableKeyRotation: true,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
    });

    // Root admin — full access so the key can always be recovered.
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.AccountRootPrincipal()],
        actions: ['kms:*'],
        resources: ['*'],
      }),
    );

    // IAM delegation — lets identity policies grant key access; needed for bucket.grant() and table.grant().
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.AccountPrincipal(cdk.Stack.of(this).account)],
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncryptFrom',
          'kms:ReEncryptTo',
          'kms:GenerateDataKey',
          'kms:GenerateDataKeyWithoutPlaintext',
          'kms:DescribeKey',
        ],
        resources: ['*'],
      }),
    );
  }

  /**
   * Allow CloudWatch Logs to use this key.
   *
   * CWL can't use IAM delegation — it needs an explicit key resource policy.
   * The condition scopes the grant to this account and region.
   */
  public grantCloudWatchLogs(region: string, account: string): void {
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [
          new iam.ServicePrincipal(`logs.${region}.amazonaws.com`),
        ],
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncryptFrom',
          'kms:ReEncryptTo',
          'kms:GenerateDataKey',
          'kms:DescribeKey',
        ],
        // '*' in a key resource policy refers to the key itself, not all AWS resources.
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': cdk.Stack.of(this).formatArn({
              service: 'logs',
              region,
              account,
              resource: 'log-group',
              resourceName: '*',
              arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            }),
          },
        },
      }),
    );
  }

  /**
   * Grant encrypt and decrypt permissions on this key to the given principal via IAM.
   */
  public grantEncryptDecrypt(grantee: iam.IGrantable): iam.Grant {
    return this.key.grantEncryptDecrypt(grantee);
  }
}
