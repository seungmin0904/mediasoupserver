const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mediasoup = require('mediasoup');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

let worker;
let router;

const transports = new Map();        // socket.id -> [transport]
const producers = new Map();         // socket.id -> [producer]
const allProducers = new Map();      // producer.id -> producer
const socketUserMap = new Map();     // socket.id -> userId
const userIdToNicknameMap = new Map(); // userId -> nickname
const channelParticipants = new Map(); // channelId -> Set<userId>

async function startMediasoupWorker() {
    worker = await mediasoup.createWorker();
    router = await worker.createRouter({
        mediaCodecs: [{
            kind: 'audio',
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2,
            parameters: { useinbandfec: 1, usedtx: 1, maxptime: 60 }
        }]
    });
    console.log('✅ mediasoup worker created');
}

io.on('connection', (socket) => {
    console.log('🔌 client connected:', socket.id);
    transports.set(socket.id, []);
    producers.set(socket.id, []);

    socket.on('register', ({ userId, nickname }) => {
        socketUserMap.set(socket.id, userId);
        userIdToNicknameMap.set(userId, nickname);
    });

    socket.on('joinVoiceChannel', ({ channelId }) => {
        const userId = socketUserMap.get(socket.id);
        if (!userId) return;

        if (!channelParticipants.has(channelId)) {
            channelParticipants.set(channelId, new Set());
        }
        channelParticipants.get(channelId).add(userId);

        emitVoiceParticipants(channelId);
    });

    socket.on('leaveVoiceChannel', ({ channelId }) => {
        console.log("🚪 leaveVoiceChannel 호출됨:", channelId);
        console.log("🎯 leave 시작 → producers:", producers.get(socket.id)?.length || 0,
            "transports:", transports.get(socket.id)?.length || 0);

        const userId = socketUserMap.get(socket.id);
        if (!userId) return;

        if (channelParticipants.has(channelId)) {
            channelParticipants.get(channelId).delete(userId);
            emitVoiceParticipants(channelId);
        }

        // allProducers 정리: 혹시 producers.get(socket.id)가 누락돼도 확실하게 정리
        for (const [id, prod] of allProducers.entries()) {
            if (prod.appData?.socketId === socket.id) {
                try {
                    prod.close();
                } catch (e) {
                    console.warn("❗ allProducers close 실패:", e);
                }
                allProducers.delete(id);
            }
        }

        // socket에 연결된 producers 정리
        (producers.get(socket.id) || []).forEach(p => {
            try { p.close(); } catch (e) { }
        });
        producers.delete(socket.id);

        // consumers 제거 (혹시 있으면)
        (transports.get(socket.id) || []).forEach(t => {
            for (const consumer of (t.consumers || [])) {
                try { consumer.close(); } catch (e) { }
            }
        });

        // transport 정리
        (transports.get(socket.id) || []).forEach(t => {
            try {
                t.removeAllListeners();
                t.close();
                console.log(`🛑 transport ${t.id} closed manually?`, t.closed);
            } catch (e) {
                console.warn("❗ transport close 실패:", e);
            }
        });
        transports.delete(socket.id);
    });

    const emitVoiceParticipants = (channelId) => {
        const set = channelParticipants.get(channelId) || new Set();
        const participants = Array.from(set).map(uid => ({
            userId: uid,
            nickname: userIdToNicknameMap.get(uid) || 'unknown'
        }));
        io.emit('voiceParticipantsUpdate', { channelId, participants });
    };

    socket.on('getRtpCapabilities', (callback) => {
        callback(router.rtpCapabilities);
    });

    socket.on('createWebRtcTransport', async ({ direction }, callback) => {
        try {
            const transport = await router.createWebRtcTransport({
                listenIps: [{ ip: '127.0.0.1', announcedIp: null }],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
            });

            transport.on('icestatechange', (state) => {
                console.log(`🔄 ICE state changed for transport ${transport.id}: ${state}`);
            });

            transport.on('dtlsstatechange', (state) => {
                console.log(`🔐 DTLS state changed for transport ${transport.id}: ${state}`);
            });
            transports.get(socket.id).push(transport);

            callback({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            });
        } catch (err) {
            callback({ error: err.message });
        }
    });

    socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
        const all = transports.get(socket.id) || [];
        const transport = all.find(t => t.id === transportId);
        if (!transport) return callback({ error: 'Transport not found' });

        try {
            await transport.connect({ dtlsParameters });
            callback('success');
        } catch (err) {
            callback({ error: err.message });
        }
    });

    socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
        const all = transports.get(socket.id) || [];
        const transport = all.find(t => t.id === transportId);
        if (!transport) return callback({ error: 'Transport not found' });

        try {
            const producer = await transport.produce({ kind, rtpParameters, appData: { socketId: socket.id } });
            if (!producers.has(socket.id)) {
                producers.set(socket.id, []);
            }
            producers.get(socket.id).push(producer);

            allProducers.set(producer.id, producer);
            callback({ id: producer.id });

            socket.broadcast.emit('newProducer', { producerId: producer.id, socketId: socket.id });
        } catch (err) {
            callback({ error: err.message });
        }
    });

    socket.on('getProducers', (callback) => {
        callback(Array.from(allProducers.keys()));
    });

    socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
        const all = transports.get(socket.id) || [];
        const transport = all.find(t => t.id === transportId);
        if (!transport) return callback({ error: 'Transport not found' });

        const producer = allProducers.get(producerId);
        if (!producer) return callback({ error: 'Producer not found' });

        try {
            const consumer = await transport.consume({
                producerId,
                rtpCapabilities,
                paused: false,
            });

            callback({
                id: consumer.id,
                producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
            });
        } catch (err) {
            callback({ error: err.message });
        }
    });

    socket.on('disconnect', () => {
        console.log('❌ client disconnected:', socket.id);
        const userId = socketUserMap.get(socket.id);
        socketUserMap.delete(socket.id);

        for (const [channelId, set] of channelParticipants.entries()) {
            if (set.delete(userId)) emitVoiceParticipants(channelId);
        }

        const prods = producers.get(socket.id) || [];
        prods.forEach(p => {
            allProducers.delete(p.id);
            p.close();
        });
        producers.delete(socket.id);

        const trans = transports.get(socket.id) || [];
        trans.forEach(t => {
            try {
                t.removeAllListeners(); // 이벤트 리스너 제거
                t.close();
            } catch (err) {
                console.warn("❗ transport close error:", err);
            }
        });
        transports.delete(socket.id);
    });
});

server.listen(4000, () => console.log('🚀 Server listening on port 4000'));
startMediasoupWorker();
