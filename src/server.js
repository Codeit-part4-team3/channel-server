const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const wrtc = require("wrtc");
const AWS = require("aws-sdk");
const crypto = require("crypto");

// .DocumentClient를 사용하면 DynamoDB의 데이터를 쉽게 다룰 수 있다. 자동 직렬화 느낌
const dynamoDB = new AWS.DynamoDB.DocumentClient({
    // 다이나모DB의 리전을 설정한다(다이나모 DB가 존재하는 지역)
    region: "us-east-2",
});
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        // origin은 정확한 클라이언트 주소여야한다.
        origin: ["https://pqsoft.net", "http://localhost:5173"],
        methods: ["GET", "POST", "PUT", "DELETE"],
    },
});

app.get("/", (req, res) => {
    res.send("Hello World!");
});

const pc_config = {
    iceServers: [
        {
            urls: ["stun:stun.l.google.com:19302"],
        },
        // {
        //     urls: ["turn:54.180.127.213:3478"],
        //     username: "codeit", // 사용자 이름(username) 설정
        //     credential: "sprint101!", // 비밀번호(password) 설정
        // },
    ],
};

// SFU 방식
// // rooms.roomName.participants = {socketId: socket.id, socketId: socket.id, ...}
// // rooms.roomName.receiverPCs[senderPCId] = pc
// // rooms.roomName.senderPCs[senderPCId][receiverPCId] = pc
// // receiverPCs의 senderPCId는 미디어 스트림을 보내는 socket의 socket.id이고
// // receiverPCId는 미디어 스트림을 받는 socket의 socket.id이다.
// const rooms = {};
// // streams.roomName.senderPCId = stream
// const streams = {};

// P2P 방식
// rooms.roomName = [{socketId: socket.id, userId: userId}, {socketId: socket.id, userId: userId}, ...]
// userId가 아닌 socket.id를 식별자로 사용하자
let rooms = {};
const maximumParticipants = 4;

io.on("connect", async (socket) => {
    // 음성, 화상 채널 관련 코드
    socket.on("join_voice_channel", ({ roomName, userId }) => {
        if (!rooms[roomName]) {
            rooms[roomName] = [];
        }
        console.log("join_voice_channel : ", roomName);
        // 만약 roomName이 꽉 찼다면, 참가할 수 없다.
        if (rooms[roomName].length === maximumParticipants) {
            socket.emit("room_full");
            return;
        }
        rooms[roomName].push({ socketId: socket.id, userId });
        socket.join(roomName);

        // roomName에 있는 방금 참여한 참가자를 제외한 참가자들을 가져와서 보낸다
        const participants = rooms[roomName].filter(
            (participant) => participant.socketId !== socket.id
        );
        console.log("participants : ", participants);
        socket.emit("participants_list", { participants });
    });

    socket.on(
        "offer",
        ({
            sdp,
            offerSenderSocketId,
            offerSenderId,
            offerReceiverSocketId,
        }) => {
            socket.to(offerReceiverSocketId).emit("get_offer", {
                sdp,
                offerSenderSocketId,
                offerSenderId,
            });
        }
    );

    socket.on(
        "answer",
        ({ sdp, answerSenderSocketId, answerReceiverSocketId }) => {
            socket.to(answerReceiverSocketId).emit("get_answer", {
                sdp,
                answerSenderSocketId,
            });
        }
    );

    socket.on(
        "candidate",
        ({ candidate, candidateSenderId, candidateReceiverId }) => {
            socket.to(candidateReceiverId).emit("get_candidate", {
                candidate,
                candidateSenderId,
            });
        }
    );

    socket.on(
        "video_track_enabled_changed",
        ({ enabled, userSocketId, roomName }) => {
            // roomName에 있는 자신을 제외한 모든 소켓에게 enabled가 변경된 소켓의 정보를 보낸다.
            socket.broadcast.to(roomName).emit("video_track_enabled_changed", {
                enabled,
                userSocketId,
            });
        }
    );

    socket.on("disconnect", ({ roomName }) => {
        console.log("disconnect : ", socket.id, " is disconnected");
        let room = rooms[roomName];
        if (room) {
            rooms[roomName] = room.filter(
                (participant) => participant.socketId !== socket.id
            );
            if (rooms[roomName].length === 0) {
                delete rooms[roomName];
            }
        }
        socket.to(roomName).emit("user_exit", { socketId: socket.id });
    });

    // 채팅 채널 관련 코드
    socket.on("join_chat_channel", async (roomName) => {
        console.log("join_chat_channel : ", roomName);
        // DB에서 channel 데이터 가져오기
        // DB에서 채팅 메시지 데이터 가져오기
        // 채팅 메시지 소켓으로 보내기
        socket.join(roomName);
        socket.emit("join_chat_channel_user_join", socket.id);

        // DB에서 해당 채널의 메시지를 가져와서 참가한 소켓에게 보내기
        // gsi를 이용해서 메시지를 createdAt을 기준으로 정렬해서 가져온다.
        const queryParams = {
            TableName: "pq-chat-channel-table",
            KeyConditionExpression: "channelId = :channelId",
            ExpressionAttributeValues: {
                ":channelId": roomName,
            },
            // scanIndexForward를 false로 설정하면 내림차순으로 정렬된다.
            ScanIndexForward: false,
            // limit의 개수만큼 가져온다
            Limit: 5,
        };

        // DynamoDB에서 기존 채팅 메시지를 가져온다.
        try {
            const data = await dynamoDB.query(queryParams).promise();
            console.log("lastKey:", data.LastEvaluatedKey);
            // 무한 스크롤을 위해 마지막 키를 저장한다.
            console.log("Messages fetched successfully from DynamoDB:", data);
            // 방금 참가한 소켓에게만 메시지를 보낸다.
            const initialMessages = data.Items;
            io.to(socket.id).emit("initial_chat_messages", {
                initialMessages,
                lastKey: data.LastEvaluatedKey,
            });
        } catch (error) {
            console.error("Error fetching messages from DynamoDB:", error);
        }
    });

    // interface MessageItem {
    //     channelId: string;
    //     messageId: string;
    //     message: {
    //       userId: string;
    //       message: string;
    //       createdAt: number;
    //       updatedAt: number;
    //       status: string; : 'stable' | 'editing
    //     };
    //   }
    socket.on("send_message", async ({ message, roomName, userId }) => {
        // 새로운 메시지를 DynamoDB에 업데이트
        const messageId = generateMessageId();
        const newMessageItem = {
            channelId: roomName, // Use roomName as the channelId
            createdAt: Date.now(),
            messageId: messageId,
            message: message,
            userId: userId, // Assuming a static userId for now
            updatedAt: Date.now(),
            status: "stable",
        };

        console.log("newMessage:", newMessageItem);

        // roomName에 속한 모든 소켓에게 메시지를 보낸다.(보낸 사람 포함)
        io.in(roomName).emit("receive_message", newMessageItem);

        const putParams = {
            TableName: "pq-chat-channel-table", // 테이블 이름
            Item: newMessageItem, // 새로운 메시지
        };

        console.log("Adding a new message to DynamoDB:", putParams);

        try {
            const data = await dynamoDB.put(putParams).promise();
            console.log("lastKey:", data.LastEvaluatedKey);
            console.log("Message added successfully to DynamoDB:", data);
        } catch (error) {
            console.error("Error adding message to DynamoDB:", error);
        }
    });

    // update Message
    socket.on("update_message", (messageId, roomName) => {
        // Logic
    });

    // delete Message
    socket.on("delete_message", (messageId, roomName) => {
        // Logic
    });

    // infinite scroll
    socket.on("more_messages", async ({ roomName, userSocketId, lastKey }) => {
        console.log("more_messages : ", roomName, userSocketId, lastKey);

        // gsi를 이용해서 메시지를 createdAt을 기준으로 정렬해서 가져온다.
        const queryParams = {
            TableName: "pq-chat-channel-table",
            KeyConditionExpression: "channelId = :channelId",
            ExpressionAttributeValues: {
                ":channelId": roomName,
            },
            // scanIndexForward를 false로 설정하면 내림차순으로 정렬된다.
            ScanIndexForward: false,
            // limit의 개수만큼 가져온다
            Limit: 5,
        };

        if (lastKey) {
            queryParams.ExclusiveStartKey = lastKey;
        }

        try {
            const data = await dynamoDB.query(queryParams).promise();
            // 무한 스크롤을 위해 마지막 키를 저장한다.
            console.log("Messages fetched successfully from DynamoDB:", data);
            const moreMessages = data.Items;
            const isNoMoreMessages = data.LastEvaluatedKey ? false : true;
            io.to(socket.id).emit("more_messages", {
                moreMessages,
                lastKey: data.LastEvaluatedKey,
                isNoMoreMessages,
            });
        } catch (error) {
            console.error("Error fetching messages from DynamoDB:", error);
        }
    });
});

// Generate a random message ID
function generateMessageId() {
    return crypto.randomBytes(16).toString("hex");
}

server.listen(3000, () => {
    console.log("SERVER IS RUNNING");
});
