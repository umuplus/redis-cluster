"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clusterFiles = void 0;
const os_1 = require("os");
const fs_1 = require("fs");
let ipAddress;
const netGroups = Object.values((0, os_1.networkInterfaces)());
for (const netGroup of netGroups) {
    if (!netGroup)
        continue;
    for (const net of netGroup) {
        const familyV4Value = typeof net.family === 'string' ? 'IPv4' : 4;
        if (net.family === familyV4Value && !net.internal) {
            if (net.address.startsWith('10.')) {
                ipAddress = net.address;
                break;
            }
        }
    }
}
const clusterFilesPath = `${process.env.HOME}/cluster-files`;
exports.clusterFiles = {
    password: (0, fs_1.readFileSync)(`${clusterFilesPath}/password`, 'utf-8').trim(),
    privateKey: (0, fs_1.readFileSync)(`${clusterFilesPath}/key.pem`, 'utf-8'),
    publicKey: (0, fs_1.readFileSync)(`${clusterFilesPath}/key.pub`, 'utf-8'),
    credentials: JSON.parse((0, fs_1.readFileSync)(`${clusterFilesPath}/credentials.json`, 'utf-8')),
    replicas: parseInt((0, fs_1.readFileSync)(`${clusterFilesPath}/replicas`, 'utf-8').trim()),
    nlb: (0, fs_1.readFileSync)(`${clusterFilesPath}/nlb`, 'utf-8').trim(),
    targetGroup: (0, fs_1.readFileSync)(`${clusterFilesPath}/target-group`, 'utf-8').trim(),
    ipAddress,
};
