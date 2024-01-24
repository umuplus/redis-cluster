"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRedisNodes = void 0;
function parseRedisNodes(payload) {
    const rawNodes = payload.split('\n').filter((node) => node?.trim());
    const nodes = rawNodes.reduce((final, node) => {
        if (node.startsWith('Warning'))
            return final;
        const [id, ipAddress, _flags, masterId, _ping, _pong, _epoch, status] = node.split(' ');
        const [ip] = ipAddress.split(':');
        const master = masterId === '-';
        final[ip] = {
            id,
            ip,
            master,
            healthy: status === 'connected',
            slaveOf: master ? undefined : masterId,
            slaves: [],
        };
        return final;
    }, {});
    const ips = Object.keys(nodes);
    for (const ip of ips) {
        const node = nodes[ip];
        if (node.master)
            continue;
        const masterOfTheNodeIp = ips.find(i => nodes[i].id === node.slaveOf);
        if (!masterOfTheNodeIp)
            continue;
        nodes[masterOfTheNodeIp].slaves.push(node.id);
    }
    return nodes;
}
exports.parseRedisNodes = parseRedisNodes;
