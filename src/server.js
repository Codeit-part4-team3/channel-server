const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const wrtc = require("wrtc");
const AWS = require("aws-sdk");

// .DocumentClient를 사용하면 DynamoDB의 데이터를 쉽게 다룰 수 있다. 자동 직렬화 느낌
const dynamoDB = new AWS.DynamoDB.DocumentClient({
    region: "ap-northeast-2",
});
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        // origin은 정확한 클라이언트 주소여야한다.
        origin: "https://pqsoft.net",
        methods: ["GET", "POST", "PUT", "DELETE"],
    },
});

app.get("/", (req, res) => {
    res.send("Hello World!");
});

console.log("connect express");

const pc_config = {
    iceServers: [
        {
            urls: ["stun:stun.l.google.com:19302"],
        },
    ],
};

// rooms.roomName.participants = [id: socket.id, id: socket.id, ...]
// rooms.roomName.senderPCs[socket.id] = pc
// rooms.roomName.receiverPCs[socket.id][otherSocket.id] = pc
// receiverPCs의 socket.id는 받는 사람의 socket.id이고 otherSocket.id는 보내는 사람의 socket.id이다.
const rooms = {};
// streams.roomName.socketId = stream
const streams = {};

io.on("connect", (socket) => {
    console.log("connect socket");
    // 음성, 화상 채널 관련 코드
    socket.on("join_voice_channel", (roomName) => {
        console.log("join_room : ", roomName);
        if (!rooms[roomName]) {
            rooms[roomName] = {
                senderPCs: {},
                receiverPCs: {},
                participants: [],
            };
        }

        const pc = new wrtc.RTCPeerConnection(pc_config);

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                socket.emit("ice_candidate_sender", e.candidate);
            }
        };

        pc.ontrack = (e) => {
            if (!streams[roomName]) {
                streams[roomName] = {};
            }
            streams[roomName][socket.id] = e.streams[0];
            console.log(streams);
        };

        if (!rooms[roomName].senderPCs[socket.id]) {
            rooms[roomName].senderPCs[socket.id] = {};
        }
        rooms[roomName].senderPCs[socket.id] = pc;
        rooms[roomName].participants.push({ id: socket.id });
    });

    socket.on("offer", async (offer, roomName) => {
        try {
            const senderPC = rooms[roomName].senderPCs[socket.id];
            await senderPC.setRemoteDescription(
                new wrtc.RTCSessionDescription(offer)
            );
            const answer = await senderPC.createAnswer();
            await senderPC.setLocalDescription(
                new wrtc.RTCSessionDescription(answer)
            );
            socket.emit("answer", answer);

            // Create receiverPCs for other participants in the room
            for (const participant of rooms[roomName].participants) {
                const participantId = participant.id;
                if (participantId === socket.id) continue;

                const receiverPC = new wrtc.RTCPeerConnection(pc_config);
                receiverPC.onicecandidate = (e) => {
                    if (e.candidate) {
                        socket.emit(
                            "ice_candidate_receiver",
                            e.candidate,
                            participantId
                        );
                    }
                };

                // Add tracks to the receiverPC from the corresponding stream
                if (streams[roomName] && streams[roomName][participantId]) {
                    streams[roomName][participantId]
                        .getTracks()
                        .forEach((track) => {
                            receiverPC.addTrack(
                                track,
                                streams[roomName][participantId]
                            );
                        });
                }

                // Create an offer for the receiverPC and emit it to the participant
                const receiverOffer = await receiverPC.createOffer();
                await receiverPC.setLocalDescription(receiverOffer);
                socket.emit(
                    "receiver_offer",
                    receiverOffer,
                    participantId,
                    roomName
                );

                // Store the receiverPC in the data structure
                if (!rooms[roomName].receiverPCs[socket.id]) {
                    rooms[roomName].receiverPCs[socket.id] = {};
                }
                rooms[roomName].receiverPCs[socket.id][participantId] =
                    receiverPC;
            }
        } catch (error) {
            console.error("Error handling offer:", error);
        }
    });

    socket.on("receiver_answer", async (answer, senderId, roomName) => {
        try {
            const receiverPC = rooms[roomName].receiverPCs[socket.id][senderId];
            await receiverPC.setRemoteDescription(
                new wrtc.RTCSessionDescription(answer)
            );
        } catch (error) {
            console.error("Error handling receiver answer:", error);
        }
    });

    socket.on("ice_candidate_sender", async (candidate, senderId, roomName) => {
        console.log("ice_candidate_sender : ", candidate);
        try {
            if (!rooms[roomName]) {
                console.error(`Room ${roomName} does not exist.`);
                return;
            }
            const senderPC = rooms[roomName].senderPCs[senderId];
            await senderPC.addIceCandidate(new wrtc.RTCIceCandidate(candidate));
        } catch (error) {
            console.error("Error handling ice candidate for senderPC:", error);
        }
    });

    socket.on(
        "ice_candidate_receiver",
        async (candidate, receiverId, senderId, roomName) => {
            try {
                if (!rooms[roomName]) {
                    console.error(`Room ${roomName} does not exist.`);
                    return;
                }
                const receiverPC =
                    rooms[roomName].receiverPCs[receiverId][senderId];
                await receiverPC.addIceCandidate(
                    new wrtc.RTCIceCandidate(candidate)
                );
            } catch (error) {
                console.error(
                    "Error handling ice candidate for receiverPC:",
                    error
                );
            }
        }
    );

    // 채팅 채널 관련 코드
    socket.on("join_chat_channel", (roomName) => {
        // DB에서 channel 데이터 가져오기
        // DB에서 채팅 메시지 데이터 가져오기
        // 채팅 메시지 소켓으로 보내기
        socket.join(roomName);
    });

    socket.on("send_message", (message, roomName) => {
        socket.to(roomName).emit("receive_message", message);
        // DB에 채팅 메시지 데이터 저장
        const params = {
            TableName: "sadasd",
            Item: {
                channel: roomName,
                message: message,
                timestamp: Date.now(),
            },
        };
        dynamoDB.put(params, (err, data) => {
            if (err) {
                console.error("Error saving message to DynamoDB", err);
            } else {
                console.log("Message saved to DynamoDB", data);
            }
        });

        // DB에 채팅 메시지 데이터 수정

        // DB에 채팅 메시지 데이터 삭제
    });
});

server.listen(3000, () => {
    console.log("SERVER IS RUNNING");
});
