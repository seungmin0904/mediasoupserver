// ✅ 1. 모듈 import
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mediasoup = require('mediasoup');

// ✅ 2. 서버 초기화
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
    },
});

// ✅ 3. 전역 상태 선언 (❗반드시 여기에)
let worker;
let router;
let transports = []; // 전역 WebRTC Transport 목록
let producers = [];  // 전역 Producer 목록

// ✅ 4. mediasoup worker 생성 함수 정의
async function startMediasoupWorker() {
    worker = await mediasoup.createWorker();
    console.log('✅ mediasoup worker created');

    worker.on('died', () => {
        console.error('❌ mediasoup worker died, exiting in 2s...');
        setTimeout(() => process.exit(1), 2000);
    });

    router = await worker.createRouter({
        mediaCodecs: [
            {
                kind: 'audio',
                mimeType: 'audio/opus',
                clockRate: 48000,
                channels: 2,
            },
        ],
    });
}

// ✅ 5. WebRTC Transport 생성 함수 정의
async function createWebRtcTransport() {
    console.log('🛠️ createWebRtcTransport() 호출됨');

    const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: '0.0.0.0', announcedIp: null }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
    });

    console.log('✅ WebRTC Transport 생성됨:', transport.id);
    console.log('📦 ICE Params:', transport.iceParameters);
    console.log('📦 ICE Candidates:', transport.iceCandidates.length);
    console.log('📦 DTLS Params:', transport.dtlsParameters);

    transports.push(transport);

    return {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
    };
}

// ✅ 6. socket.io 연결 핸들러
io.on('connection', (socket) => {
    console.log('🔌 client connected:', socket.id);

    // 클라이언트에게 Router의 RTP Capabilities 전달
    socket.on('getRtpCapabilities', (callback) => {
        if (!router) {
            console.error('❌ Router not ready');
            return callback({ error: 'Router not ready' });
        }
        console.log('📡 Sending RTP Capabilities to client:', socket.id);
        callback(router.rtpCapabilities);
    });

    // Transport 생성 요청 처리
    socket.on('createWebRtcTransport', async ({ direction: _ }, callback) => {
        try {
            const transportOptions = await createWebRtcTransport();
            callback(transportOptions);
        } catch (err) {
            console.error('❌ Error creating WebRtcTransport:', err);
            callback({ error: err.message });
        }
    });

    // Transport 연결 (DTLS 파라미터)
    socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
        console.log('📥 Received createWebRtcTransport request from:', socket.id, 'direction:', direction);
        const transport = transports.find((t) => t.id === transportId);
        if (!transport) return callback({ error: 'Transport not found' });

        try {
            await transport.connect({ dtlsParameters });
            console.log('✅ Transport created. Returning options to client.');
            callback('success');
        } catch (err) {
            console.error('❌ Transport connect error:', err);
            callback({ error: err.message });
        }
    });

    // Producer 생성 요청 처리 (송신 트랙)
    socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
        const transport = transports.find((t) => t.id === transportId);
        if (!transport) return callback({ error: 'Transport not found' });

        try {
            const producer = await transport.produce({ kind, rtpParameters });
            producers.push(producer);
            console.log('✅ producer created:', producer.id);
            callback({ id: producer.id });
        } catch (err) {
            console.error('❌ Produce error:', err);
            callback({ error: err.message });
        }
    });
});

// ✅ 7. 서버 실행
server.listen(4000, () => {
    console.log('🚀 server listening on port 4000');
});

// ✅ 8. mediasoup 초기화 시작
startMediasoupWorker();

// ✅ 9. 전역 에러 핸들링 (맨 마지막에 추가)
process.on('uncaughtException', (err) => {
    console.error('🧨 Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('🧨 Unhandled Rejection:', reason);
});