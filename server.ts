import { serve } from "https://deno.land/std@0.75.0/http/server.ts"
import { acceptWebSocket, WebSocket } from "https://deno.land/std@0.75.0/ws/mod.ts"
const server = serve(":8080")
console.log(`Chat server is running on 8080`)
const client = Deno.env.get('GROQ_API_KEY');

let users: WebSocket[] = []

for await (const req of server) {
    try {
        const { conn, r: bufReader, w: bufWriter, headers } = req
        let socket = await acceptWebSocket({
            conn,
            bufReader,
            bufWriter,
            headers,
        })

        try {
            handleWs(socket)
        } catch (err) {
            console.error(`failed to receive frame: ${err}`)

            if (!socket.isClosed) {
                await socket.close(1000).catch(console.error)
            }
        }

    } catch (error) {
        try {
            let headers = new Headers()
            let data

            if (req.url === "/" || req.url === "/index.html") {
                headers.set("Content-Type", "text/html")
                data = await Deno.readTextFile("index.html")
            } else if (req.url === "/styles.css") {
                headers.set("Content-Type", "text/css")
                data = await Deno.readTextFile("styles.css")
            } else if (req.url === "/frontend.js") {
                headers.set("Content-Type", "text/javascript")
                data = await Deno.readTextFile("frontend.js")
            } else {
                throw 404
            }

            await req.respond({ status: 200, body: data, headers: headers })
        } catch {
            await req.respond({ status: 404 })
        }
    }
}

async function handleWs(socket: WebSocket) {
    for await (const event of socket) {
        if (typeof event === "string") {
            const parsedEvent = JSON.parse(event)
            if (parsedEvent.type === "open") {
                console.log("Connection established with a client.")
                users.push(socket)

                await socket.send(JSON.stringify({
                    type: "message",
                    data: {
                        name: "SERVER",
                        message: "Hello, welcome to the webchat!"
                    }
                }))
            } else if (parsedEvent.type === "message") {
                console.dir(parsedEvent)

                users = users.filter(user => {
                    try {
                        user.send(JSON.stringify(parsedEvent))
                        return true
                    } catch {
                        return false
                    }
                })

                const aiResponse = await fetchAIResponse(parsedEvent.data.message)
                const aiMessage = {
                    type: "message",
                    data: {
                        name: "Groq AI",
                        message: aiResponse
                    }
                }

                users = users.filter(user => {
                    try {
                        user.send(JSON.stringify(aiMessage))
                        return true
                    } catch {
                        return false
                    }
                })

                console.log(`There ${users.length === 1 ? "is" : "are"} ${users.length} ${users.length === 1 ? "user" : "users"} online`)
            }
        }
    }
}

console.log("Fetching AI response with prompt:", prompt);

const response = await fetch("https://api.groq.ai/generate-response", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${client}`
    },
    body: JSON.stringify({
        messages: [
            {
                role: 'system',
                content: prompt,
            },
            {
                role: 'user',
                content: prompt,
            },
        ],
        model: 'mixtral-8x7b-32768',
        temperature: 0.5,
        max_tokens: 1024,
        top_p: 1,
        stop: null,
        stream: false
    })
});

