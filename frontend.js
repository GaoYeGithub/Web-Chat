let ws

document.addEventListener("DOMContentLoaded", _ => {
    ws = new WebSocket(`wss://${window.location.host}`)

    const name = document.getElementById("name")
    const message = document.getElementById("message")

    ws.onopen = function () {
        console.log("Socket connection is open")
        ws.send(JSON.stringify({ type: "open", data: {} }))
    }

    ws.onmessage = function (event) {
        console.log("Message received")
        const msg = JSON.parse(event.data)
        console.log(msg.data)
        addMessages(msg.data)
    }

    document.getElementById("send").addEventListener("click", sendMessage)
    message.addEventListener("keypress", function (event) {
        if (event.key === "Enter") {
            sendMessage()
        }
    })

    function addMessages(message) {
        const messageLog = document.getElementById("messageLog")
        const isAI = message.name === "Groq AI"

        messageLog.insertAdjacentHTML(
            'beforeend',
            `<p${isAI ? ' class="ai-message"' : ''}><b>${message.name}</b>: ${message.message}</p>`
        )
    }

    function sendMessage() {
        if (name.value.trim() === "") {
            alert("Please enter your name")
        } else if (message.value.trim() === "") {
            alert("Please enter your message")
        } else {
            ws.send(JSON.stringify({
                type: "message",
                data: {
                    name: name.value,
                    message: message.value
                }
            }))
            message.value = ""
        }
    }
})
