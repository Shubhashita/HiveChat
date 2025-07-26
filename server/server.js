import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import bodyParser from "body-parser";
import pg from 'pg';
import bcrypt from 'bcrypt';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';

const app = express();
const port = process.env.PORT || 5000;
const saltRounds = 10;

const server = http.createServer(app);

const { Pool } = pg;

const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
    connectionTimeoutMillis: 2000, // Return an error if connection takes longer than 2 seconds
});

// Test the connection
db.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection error:', err.stack);
    } else {
        console.log('✅ Connected to PostgreSQL database');
        release(); // Release the client back to the pool
    }
});
db.connect();

//Middleware
app.use(cors({
    origin: [process.env.CLIENT_URL, `http://localhost:${port}`], // Allow both React dev and prod
    methods: ["GET", "POST"],
    credentials: true // If you're using cookies or sessions
}));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());


app.get("/", (req, res) => {
    res.send("Server is running!");
});

// Get all users (for sidebar)
app.get("/users", async (req, res) => {
    try {
        const result = await db.query("SELECT id, username, email FROM users");
        res.json(result.rows);
    } catch (err) {
        console.log("Fetch users error:", err);
        res.status(500).json({ message: "Server error" });
    }
});

// Get all messages between two users
app.get("/messages", async (req, res) => {
    const { user1, user2 } = req.query;
    if (!user1 || !user2) {
        return res.status(400).json({ message: "Missing user ids" });
    }
    try {
        const result = await db.query(
            `SELECT * FROM messages
            WHERE (sender_id = $1 AND recipient_id = $2)
                OR (sender_id = $2 AND recipient_id = $1)
            ORDER BY timestamp ASC`,
            [user1, user2]
        );
        res.json(result.rows);
    } catch (err) {
        console.log("Fetch messages error:", err);
        res.status(500).json({ message: "Server error" });
    }
});

// Save a new message
app.post("/messages", async (req, res) => {
    const { sender_id, recipient_id, text, timestamp } = req.body;
    if (!sender_id || !recipient_id || !text) {
        return res.status(400).json({ message: "Missing fields" });
    }
    try {
        const result = await db.query(
            `INSERT INTO messages (sender_id, recipient_id, text, timestamp)
            VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [sender_id, recipient_id, text, timestamp || new Date()]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.log("Save message error:", err);
        res.status(500).json({ message: "Server error" });
    }
});

//Register
app.post("/register", async (req, res) => {
    const { username, email, password } = req.body;

    try {
        const checkResult = await db.query("SELECT * FROM users WHERE email = $1", [
            email,
        ]);

        if (checkResult.rows.length > 0) {
            return res.status(409).json({ message: "Email already exists. Try logging in." });
        }

        const hashedPassword = await bcrypt.hash(password, saltRounds);

        await db.query("INSERT INTO users (username, email, password) VALUES ($1, $2, $3)",
            [username, email, hashedPassword]
        );

        res.status(201).json({ message: 'Registered, Login to Continue' });
    } catch (err) {
        console.log("Registration error:", err);
        res.status(500).json({ message: "Server error" })
    }
});

app.post("/login", async (req, res) => {
    const { email, password } = req.body;

    try {
        const result = await db.query("SELECT * FROM users WHERE email = $1", [email]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        const user = result.rows[0];
        const passwordMatch = await bcrypt.compare(password, user.password);

        if (passwordMatch) {
            // Remove password before sending user object
            const { password, ...userWithoutPassword } = user;
            res.status(200).json({ message: "Login successful", user: userWithoutPassword });
        } else {
            res.status(401).json({ message: "Incorrect password" });
        }

    } catch (err) {
        console.log("Login error:", err);
        res.status(500).json({ message: "Server error" });
    }
});

// --- Socket.io setup ---
const io = new Server(server, {
    cors: {
        origin: [process.env.CLIENT_URL, `http://localhost:${port}`],
        methods: ["GET", "POST"]
    }
});

// Store userId <-> socketId mapping for direct messaging
const userSocketMap = new Map();

io.on('connection', (socket) => {
    // Listen for user identification (on login)
    socket.on('identify', (userId) => {
        userSocketMap.set(userId, socket.id);
    });

    // Real-time fetch users, excluding the current user if provided
    socket.on('getUsers', async (data) => {
        try {
            let result;
            if (data && data.excludeId) {
                result = await db.query("SELECT id, username, email FROM users WHERE id != $1", [data.excludeId]);
            } else {
                result = await db.query("SELECT id, username, email FROM users");
            }
            socket.emit('usersList', result.rows);
        } catch (err) {
            socket.emit('usersList', []);
        }
    });

    // Real-time 1-to-1 chat
    socket.on('sendMessage', (msg) => {
        // msg: { from, to, text, time }
        const toSocketId = userSocketMap.get(msg.to);
        if (toSocketId) {
            io.to(toSocketId).emit('receiveMessage', msg);
        }
        // Also emit to sender for instant feedback
        socket.emit('receiveMessage', msg);
    });

    socket.on('disconnect', () => {
        // Remove user from map if disconnected
        for (const [userId, sockId] of userSocketMap.entries()) {
            if (sockId === socket.id) {
                userSocketMap.delete(userId);
                break;
            }
        }
        // console.log('User disconnected:', socket.id);
    });
});

server.listen(port, () => {
    console.log(`✅ Server and Socket.io running on port ${port}`);
});