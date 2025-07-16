const express = require('express');
const fs = require('fs');
const https = require('https');
const socketIo = require('socket.io');
const mediasoup = require('mediasoup');

const app = express();

// HTTPS 인증서 로드
const credentials = {
    key: fs.readFileSync('/etc/letsencrypt/live/serverpro.kro.kr/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/serverpro.kro.kr/fullchain.pem')
};

const httpsServer = https.createServer(credentials, app);
// (credentials, app); https 사용시

const io = socketIo(httpsServer, {
    path: "/socket.io",
    cors: {
        origin: [
            "https://serverpro.kro.kr",
            "https://api.serverpro.kro.kr",
            "http://localhost:5173"
        ],
        methods: ["GET", "POST"],
        credentials: true
    }
});

let worker;
let router;

const transports = new Map();
const producers = new Map();
const allProducers = new Map();
const socketUserMap = new Map();
const userIdToNicknameMap = new Map();
const channelParticipants = new Map();

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

        if (!producers.has(socket.id)) producers.set(socket.id, []);
        if (!transports.has(socket.id)) transports.set(socket.id, []);

        if (!channelParticipants.has(channelId)) {
            channelParticipants.set(channelId, new Set());
        }
        channelParticipants.get(channelId).add(userId);

        emitVoiceParticipants(channelId);
    });

    socket.on('leaveVoiceChannel', ({ channelId }) => {
        const userId = socketUserMap.get(socket.id);
        if (!userId) return;

        if (channelParticipants.has(channelId)) {
            channelParticipants.get(channelId).delete(userId);
            emitVoiceParticipants(channelId);
        }

        const userProducers = producers.get(socket.id) || [];
        userProducers.forEach((p) => {
            try { p.close(); } catch (e) { console.warn("❗ producer close error:", e); }
            allProducers.delete(p.id);
        });
        producers.delete(socket.id);

        const userTransports = transports.get(socket.id) || [];
        userTransports.forEach((t) => {
            (t.consumers || []).forEach((c) => { try { c.close(); } catch (e) { } });
            try {
                t.close();
                console.log(`🛑 [LEAVE] transport ${t.id} closed manually?`, t.closed);
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
                listenIps: [{ ip: '0.0.0.0', announcedIp: '3.35.114.7' }],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
            });

            if (!transports.has(socket.id)) transports.set(socket.id, []);
            transports.get(socket.id).push(transport);

            transport.on('icestatechange', (state) => {
                console.log(`🔄 [TRANSPORT ${transport.id}] ICE state changed: ${state}`);
            });
            transport.on('dtlsstatechange', (state) => {
                console.log(`🔐 [TRANSPORT ${transport.id}] DTLS state changed: ${state}`);
            });

            callback({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
                iceServers: [
                    {
                        urls: 'turn:3.35.114.7:3478',
                        username: 'testuser',
                        credential: 'testpass'
                    }
                ]
            });
        } catch (err) {
            console.error("❌ createWebRtcTransport error:", err);
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
            const producer = await transport.produce({
                kind,
                rtpParameters,
                appData: { socketId: socket.id },
                traceEventTypes: ['rtp']
            });

            producer.on('trace', (trace) => {
                if (trace.type === 'rtp') {
                    console.log(`📡 RTP packet sent for producer ${producer.id}`);
                }
            });

            if (!producers.has(socket.id)) producers.set(socket.id, []);
            producers.get(socket.id).push(producer);
            allProducers.set(producer.id, producer);
            callback({ id: producer.id });

            socket.broadcast.emit('newProducer', {
                producerId: producer.id,
                socketId: socket.id,
                userId: socketUserMap.get(socket.id)
            });
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
                t.close();
                console.log(`🛑 [DISCONNECT] transport ${t.id} closed manually?`, t.closed);
            } catch (err) {
                console.warn("❗ transport close error:", err);
            }
        });
        transports.delete(socket.id);
    });
});

httpsServer.listen(4000, '0.0.0.0', () => console.log('🚀 HTTPS Server listening on port 4000'));
startMediasoupWorker();
