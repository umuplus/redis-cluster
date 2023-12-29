import { networkInterfaces } from 'os';
import { readFileSync } from 'fs';

let ipAddress: string | undefined;
const netGroups = Object.values(networkInterfaces());
for (const netGroup of netGroups) {
    if (!netGroup) continue;

    for (const net of netGroup) {
        const familyV4Value = typeof net.family === 'string' ? 'IPv4' : 4
        if (net.family === familyV4Value && !net.internal) {
            if (net.address.startsWith('10.')) {
                ipAddress = net.address;
                break;
            }
        }
    }
}

const clusterFilesPath = `${process.env.HOME}/cluster-files`;
export const clusterFiles = {
    password: readFileSync(`${clusterFilesPath}/password`, 'utf-8'),
    privateKey: readFileSync(`${clusterFilesPath}/key.pem`, 'utf-8'),
    publicKey: readFileSync(`${clusterFilesPath}/key.pub`, 'utf-8'),
    credentials: JSON.parse(readFileSync(`${clusterFilesPath}/credentials.json`, 'utf-8')),
    nodeType: readFileSync(`${clusterFilesPath}/node-type`, 'utf-8'),
    replicas: parseInt(readFileSync(`${clusterFilesPath}/replicas`, 'utf-8')),
    ipAddress,
};
