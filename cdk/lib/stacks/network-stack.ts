import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { PROJECT_PREFIX } from '../constants';
import { Alb } from '../constructs/network/alb';
import { Vpc } from '../constructs/network/vpc';

/**
 * NetworkStack — VPC and ALB.
 *
 * The ALB serves HTTP for the demo. HTTPS can be added later by providing an
 * ACM certificate (via Route 53 Domains) and updating the Alb construct.
 *
 * Writes to SSM:
 * - /file-api/vpc-id
 * - /file-api/alb-arn
 * - /file-api/alb-sg-id
 * - /file-api/http-listener-arn
 */
export class NetworkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'Vpc');
    const alb = new Alb(this, 'Alb', { vpc: vpc.vpc });

    new ssm.StringParameter(this, 'VpcId', {
      parameterName: `/${PROJECT_PREFIX}/vpc-id`,
      stringValue: vpc.vpc.vpcId,
    });
    new ssm.StringParameter(this, 'AlbArn', {
      parameterName: `/${PROJECT_PREFIX}/alb-arn`,
      stringValue: alb.loadBalancer.loadBalancerArn,
    });
    new ssm.StringParameter(this, 'AlbSgId', {
      parameterName: `/${PROJECT_PREFIX}/alb-sg-id`,
      stringValue: alb.securityGroup.securityGroupId,
    });
    new ssm.StringParameter(this, 'HttpListenerArn', {
      parameterName: `/${PROJECT_PREFIX}/http-listener-arn`,
      stringValue: alb.httpListener.listenerArn,
    });
  }
}
