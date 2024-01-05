"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRedisNodes = void 0;
function parseRedisNodes(payload) {
    const nodes = payload.split('\n').filter((node) => node);
    return nodes.reduce((final, node) => {
        if (node.startsWith('Warning'))
            return final;
        const [id, ipAddress, _flags, masterId, _ping, _pong, _epoch, status] = node.split(' ');
        console.log('>', id, ipAddress, _flags, masterId, _ping, _pong, _epoch, status);
        const [ip] = ipAddress.split(':');
        final[ip] = {
            id,
            ip,
            master: masterId === '-',
            healthy: status === 'connected',
        };
        return final;
    }, {});
}
exports.parseRedisNodes = parseRedisNodes;
