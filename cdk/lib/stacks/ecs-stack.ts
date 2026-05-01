import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { PROJECT_PREFIX } from '../constants';
import { EcsApi } from '../app/ecs-api';

/**
 * EcsStack — Fargate compute target.
 *
 * Reads all identifiers from SSM (written by SharedStack and NetworkStack).
 * Uses valueFromLookup for VPC ID (required by Vpc.fromLookup at synth time).
 * Uses valueForStringParameter for everything else (resolved at deploy time).
 */
export class EcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const p = `/${PROJECT_PREFIX}`;

    const vpcId = ssm.StringParameter.valueFromLookup(this, `${p}/vpc-id`);
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId });

    const albSgId = ssm.StringParameter.valueForStringParameter(this, `${p}/alb-sg-id`);
    const listenerArn = ssm.StringParameter.valueForStringParameter(this, `${p}/http-listener-arn`);
    const bucketName = ssm.StringParameter.valueForStringParameter(this, `${p}/bucket-name`);
    const bucketArn = ssm.StringParameter.valueForStringParameter(this, `${p}/bucket-arn`);
    const bucketKmsKeyArn = ssm.StringParameter.valueForStringParameter(this, `${p}/bucket-kms-key-arn`);
    const tableName = ssm.StringParameter.valueForStringParameter(this, `${p}/dynamo-table-name`);
    const tableArn = ssm.StringParameter.valueForStringParameter(this, `${p}/dynamo-table-arn`);
    const tableKmsKeyArn = ssm.StringParameter.valueForStringParameter(this, `${p}/dynamo-kms-key-arn`);
    const ecrRepoUri = ssm.StringParameter.valueForStringParameter(this, `${p}/ecr-repo-uri`);

    const albSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, 'AlbSg', albSgId);
    const httpListener = elbv2.ApplicationListener.fromApplicationListenerAttributes(
      this, 'HttpsListener', { listenerArn, securityGroup: albSecurityGroup },
    );

    const api = new EcsApi(this, 'EcsApi', {
      vpc,
      httpListener,
      albSecurityGroup,
      imageUri: `${ecrRepoUri}:latest`,
      bucketName,
      bucketArn,
      bucketKmsKeyArn,
      tableName,
      tableArn,
      tableKmsKeyArn,
      awsRegion: this.region,
    });

    new ssm.StringParameter(this, 'EcsClusterName', {
      parameterName: `/${PROJECT_PREFIX}/ecs-cluster-name`,
      stringValue: api.fargate.service.cluster.clusterName,
    });
    new ssm.StringParameter(this, 'EcsServiceName', {
      parameterName: `/${PROJECT_PREFIX}/ecs-service-name`,
      stringValue: api.fargate.service.serviceName,
    });
  }
}
