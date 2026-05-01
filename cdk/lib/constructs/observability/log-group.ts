import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { KmsKey } from '../security/kms-key';

export interface LogGroupProps {
  /** CloudWatch log group name. Recommended pattern: /stratocore/{service}. */
  readonly logGroupName: string;
  /**
   * KMS key used to encrypt log data at rest.
   * The construct calls key.grantCloudWatchLogs() automatically.
   */
  readonly encryptionKey: KmsKey;
  /**
   * How long to retain log events.
   * @default RetentionDays.THREE_MONTHS
   */
  readonly retention?: logs.RetentionDays;
  /**
   * Removal policy for the log group.
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: cdk.RemovalPolicy;
}

/**
 * A CloudWatch Log Group encrypted with a customer-managed KMS key.
 *
 * Delegates the CloudWatch Logs key resource policy to KmsKey.grantCloudWatchLogs()
 * so the policy logic stays in the security construct, not here.
 */
export class LogGroup extends Construct {
  /** The underlying CDK log group. Pass to ECS or App Runner constructs. */
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: LogGroupProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // The key resource policy for CloudWatch Logs belongs in KmsKey — we just trigger it.
    props.encryptionKey.grantCloudWatchLogs(stack.region, stack.account);

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: props.logGroupName,
      encryptionKey: props.encryptionKey.key,
      retention: props.retention ?? logs.RetentionDays.TWO_MONTHS,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
    });
  }
}
