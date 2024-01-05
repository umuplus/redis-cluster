import { clusterFiles } from './config';
import { EC2 } from '@aws-sdk/client-ec2';

const instanceName = 'RedisClusterNode';

export async function getInstances(): Promise<string[]> {
    const ec2 = new EC2(clusterFiles.credentials);
    const { Reservations } = await ec2.describeInstances({
        Filters: [
            { Name: 'instance-state-name', Values: ['running'] },
            { Name: 'tag:Name', Values: [`${instanceName}*`] },
        ],
    });
    if (!Reservations?.length) return [];

    return Reservations.reduce((final: string[], current) => {
        if (current.Instances?.length)
            for (let instance of current.Instances)
                if (instance.PrivateIpAddress && !final.includes(instance.PrivateIpAddress))
                    final.push(instance.PrivateIpAddress);
        return final;
    }, []);
}
