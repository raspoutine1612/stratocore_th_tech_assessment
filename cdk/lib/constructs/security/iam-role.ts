import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface IamRoleProps {
  /** The AWS service principal that can assume this role (e.g. ecs-tasks, apprunner). */
  readonly assumedBy: iam.IPrincipal;
  /** Human-readable description of the role's purpose. */
  readonly description?: string;
  /**
   * AWS-managed or customer-managed policies to attach at creation time.
   * @default []
   */
  readonly managedPolicies?: iam.IManagedPolicy[];
}

/**
 * An IAM role with a confused-deputy deny in the trust policy.
 *
 * The deny blocks any principal whose aws:SourceAccount differs from this account.
 * StringNotEquals on a missing key is false, so direct IAM assume-role is not affected.
 */
export class IamRole extends Construct {
  /** The underlying CDK role. Pass to compute and pipeline constructs. */
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: IamRoleProps) {
    super(scope, id);

    this.role = new iam.Role(this, 'Role', {
      assumedBy: props.assumedBy,
      description: props.description,
      managedPolicies: props.managedPolicies ?? [],
    });

    this.role.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['sts:AssumeRole'],
        conditions: {
          StringNotEquals: {
            'aws:SourceAccount': cdk.Stack.of(this).account,
          },
        },
      }),
    );
  }
}
