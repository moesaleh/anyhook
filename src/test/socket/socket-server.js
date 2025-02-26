const uWebSocket = require('uWebSockets.js');

// Create a WebSocket server that listens on port 9001
const app = uWebSocket.App({});

app.ws('/*', {
    open: (ws) => {
        console.log('Client connected');
        
        // Send data to the client every 1 minute
        ws.intervalId = setInterval(() => {
            const payload = JSON.stringify({
                event: 'order_created',
                data: {
                    orderId: Math.floor(Math.random() * 1000),
                    amount: Math.floor(Math.random() * 100),
                }
            });
            ws.send(payload);
            console.log('Pushed data to client:', payload);
        }, 300000);
    },
    
    close: (ws, code, message) => {
        console.log('Client disconnected');
        clearInterval(ws.intervalId); // Clear the interval when the client disconnects
    },
    
    message: (ws, message, isBinary) => {
        console.log('Message received from client:', Buffer.from(message).toString());
    }
});

app.listen(9001, (token) => {
    if (token) {
        console.log('WebSocket server is running on ws://localhost:9001');
    } else {
        console.log('Failed to start WebSocket server');
    }
});
