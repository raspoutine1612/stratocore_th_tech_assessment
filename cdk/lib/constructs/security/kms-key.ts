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
 * A KMS key with automatic annual rotation and a mandatory admin policy.
 *
 * Two statements are always added to the key resource policy:
 *
 * 1. Root admin — allows the account root principal to perform any KMS action.
 *    Without this, removing all grants makes the key permanently unusable.
 *
 * 2. IAM delegation — allows IAM identity policies in the same account to grant
 *    access to the key. This is what makes CDK's bucket.grant() and table.grant()
 *    work without adding explicit key policy entries for every grantee.
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

    // Statement 1 — root admin.
    // Grants the account root full KMS access so the key can always be managed,
    // even if all other grants and policies are accidentally removed.
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.AccountRootPrincipal()],
        actions: ['kms:*'],
        resources: ['*'],
      }),
    );

    // Statement 2 — IAM delegation.
    // Allows IAM identity policies (attached to roles, users, groups) in this account
    // to grant access to the key. Without this, only key resource policy entries work.
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
   * Allow the CloudWatch Logs service to use this key for log group encryption.
   *
   * CloudWatch Logs requires an explicit resource policy on the KMS key — it cannot
   * use a key via IAM delegation alone. Call this before passing the key to a LogGroup.
   *
   * The condition scopes the grant to log groups in the same account and region.
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
