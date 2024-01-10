import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { AutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';
import {
    CfnKeyPair,
    GenericLinuxImage,
    InstanceType,
    IpAddresses,
    Peer,
    Port,
    SecurityGroup,
    SubnetType,
    UserData,
    Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { join as joinPath } from 'path';
import {
    NetworkListenerAction,
    NetworkLoadBalancer,
    NetworkTargetGroup,
    TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { readFileSync } from 'fs';
import { RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { InstanceTarget } from 'aws-cdk-lib/aws-elasticloadbalancing';
import { IpTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';

const AWS_EC2_AMI_UBUNTU_2204LTS: Record<string, string> = {
    'af-south-1': 'ami-0e878fcddf2937686',
    'ap-east-1': 'ami-0d96ec8a788679eb2',
    'ap-northeast-1': 'ami-07c589821f2b353aa',
    'ap-northeast-2': 'ami-0f3a440bbcff3d043',
    'ap-northeast-3': 'ami-05ff0b3a7128cd6f8',
    'ap-south-1': 'ami-03f4878755434977f',
    'ap-south-2': 'ami-0bbc2f7f6287d5ca6',
    'ap-southeast-1': 'ami-0fa377108253bf620',
    'ap-southeast-2': 'ami-04f5097681773b989',
    'ap-southeast-3': 'ami-02157887724ade8ba',
    'ap-southeast-4': 'ami-03842bc45d2ad8394',
    'ca-central-1': 'ami-0a2e7efb4257c0907',
    'ca-west-1': 'ami-0db2fabcbd0e76d52',
    'cn-north-1': 'ami-0da6624a66d5efea8',
    'cn-northwest-1': 'ami-017ca9a70aea59fd2',
    'eu-central-1': 'ami-0faab6bdbac9486fb',
    'eu-central-2': 'ami-02e901e47eb942582',
    'eu-north-1': 'ami-0014ce3e52359afbd',
    'eu-south-1': 'ami-056bb2662ef466553',
    'eu-south-2': 'ami-0a9e7160cebfd8c12',
    'eu-west-1': 'ami-0905a3c97561e0b69',
    'eu-west-2': 'ami-0e5f882be1900e43b',
    'eu-west-3': 'ami-01d21b7be69801c2f',
    'il-central-1': 'ami-0fd2d59e9df02d839',
    'me-central-1': 'ami-0b98fa71853d8d270',
    'me-south-1': 'ami-0ce1025465c85da8d',
    'sa-east-1': 'ami-0fb4cf3a99aa89f72',
    'us-east-1': 'ami-0c7217cdde317cfec',
    'us-east-2': 'ami-05fb0b8c1424f266b',
    'us-west-1': 'ami-0ce2cb35386fc22e9',
    'us-west-2': 'ami-008fe2fc65df48dac',
};

export class RedisClusterStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        const rootFolder = joinPath(__dirname, '..');
        const packageJson = JSON.parse(readFileSync(`${rootFolder}/package.json`, 'utf-8'));
        const publicKey = readFileSync(`${rootFolder}/tmp/redis-cluster.pub`, 'utf-8');
        const privateKey = readFileSync(`${rootFolder}/tmp/redis-cluster`, 'utf-8');
        const password = readFileSync(`${rootFolder}/tmp/password`, 'utf-8');
        const credentials = readFileSync(`${rootFolder}/tmp/credentials`, 'utf-8');

        const { cluster } = packageJson;
        if (!cluster.master || cluster.master < 3)
            throw new Error('Redis cluster requires at least 3 master nodes');

        const numberOfNodes = cluster.master * (cluster.replicas + 1);
        console.log(numberOfNodes, 'cache nodes will be created as', cluster.type);

        const vpc = new Vpc(this, 'ClusterVpc', {
            ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
            maxAzs: 1,
            subnetConfiguration: [
                {
                    name: 'public-subnet-1',
                    subnetType: SubnetType.PUBLIC,
                    cidrMask: 24,
                },
            ],
        });

        new Table(this, 'OrchestrationTable', {
            tableName: 'RedisClusterTable',
            partitionKey: { name: 'pk', type: AttributeType.STRING },
            billingMode: BillingMode.PAY_PER_REQUEST,
            removalPolicy: RemovalPolicy.DESTROY,
            timeToLiveAttribute: 'exp',
        });

        const keyPair = new CfnKeyPair(this, 'KeyPair', {
            keyName: 'RedisClusterKey',
            publicKeyMaterial: publicKey,
            keyType: 'ed25519',
        });

        const securityGroup = new SecurityGroup(this, 'SecurityGroup', {
            vpc,
            allowAllOutbound: true,
        });
        securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(22));
        securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(6379));
        securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(16379));

        const nlb = new NetworkLoadBalancer(this, 'NLB', { vpc, internetFacing: true });
        const targetGroup = new NetworkTargetGroup(this, 'TargetGroup', {
            vpc,
            port: 6379,
            targetType: TargetType.IP,
        });
        nlb.addListener('Listener', {
            port: 6379,
            defaultAction: NetworkListenerAction.forward([targetGroup]),
        });

        const cacheInitPath = joinPath(rootFolder, 'scripts', 'cache-init.sh');
        const cacheInitSourceCode = readFileSync(cacheInitPath, 'utf-8')
            .replace(/{{REDIS_PASSWORD}}/g, password)
            .replace('{{PRIVATE_KEY}}', privateKey)
            .replace('{{PUBLIC_KEY}}', publicKey)
            .replace('{{CREDENTIALS}}', credentials)
            .replace('{{NLB_ARN}}', nlb.loadBalancerArn)
            .replace('{{TARGET_GROUP_ARN}}', targetGroup.targetGroupArn)
            .replace('{{CLUSTER_REPLICAS}}', cluster.replicas.toString());

        new AutoScalingGroup(this, 'RedisASG', {
            vpc,
            securityGroup,
            autoScalingGroupName: 'RedisASG',
            vpcSubnets: { subnetType: SubnetType.PUBLIC },
            instanceType: new InstanceType(cluster.type),
            machineImage: new GenericLinuxImage(AWS_EC2_AMI_UBUNTU_2204LTS),
            userData: UserData.custom(cacheInitSourceCode),
            keyName: keyPair.keyName,
            minCapacity: 0,
            maxCapacity: 0,
        });

        Tags.of(this).add('costcenter', 'redis_cluster');
    }
}
