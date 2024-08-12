import { serve } from "https://deno.land/std@0.75.0/http/server.ts";
import { acceptWebSocket } from "https://deno.land/std@0.75.0/ws/mod.ts";
const server = serve(":8080");
console.log(`Chat server is running on 8080`);
const client = Deno.env.get('GROQ_API_KEY');
let users = [];
async function fetchAIResponse(userMessage) {
    const prompt = `Response to: ${userMessage}`;
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
                    content: prompt
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            model: 'mixtral-8x7b-32768',
            temperature: 0.5,
            max_tokens: 1024,
            top_p: 1,
            stop: null,
            stream: false
        })
    });
    if (response.ok) {
        const data = await response.json();
        return data.choices[0]?.message?.content || "Sorry, I couldn't understand that.";
    } else {
        console.error("Error fetching AI response:", response.statusText);
        return "Sorry, something went wrong.";
    }
}
for await (const req of server){
    try {
        const { conn , r: bufReader , w: bufWriter , headers  } = req;
        let socket = await acceptWebSocket({
            conn,
            bufReader,
            bufWriter,
            headers
        });
        try {
            handleWs(socket);
        } catch (err) {
            console.error(`failed to receive frame: ${err}`);
            if (!socket.isClosed) {
                await socket.close(1000).catch(console.error);
            }
        }
    } catch (error) {
        try {
            let headers = new Headers();
            let data;
            if (req.url === "/" || req.url === "/index.html") {
                headers.set("Content-Type", "text/html");
                data = await Deno.readTextFile("index.html");
            } else if (req.url === "/styles.css") {
                headers.set("Content-Type", "text/css");
                data = await Deno.readTextFile("styles.css");
            } else if (req.url === "/frontend.js") {
                headers.set("Content-Type", "text/javascript");
                data = await Deno.readTextFile("frontend.js");
            } else {
                throw 404;
            }
            await req.respond({
                status: 200,
                body: data,
                headers: headers
            });
        } catch  {
            await req.respond({
                status: 404
            });
        }
    }
}
async function handleWs(socket) {
    for await (const event of socket){
        if (typeof event === "string") {
            const parsedEvent = JSON.parse(event);
            if (parsedEvent.type === "open") {
                console.log("Connection established with a client.");
                users.push(socket);
                await socket.send(JSON.stringify({
                    type: "message",
                    data: {
                        name: "SERVER",
                        message: "Hello, welcome to the webchat!"
                    }
                }));
            } else if (parsedEvent.type === "message") {
                console.dir(parsedEvent);
                // Broadcast the user's message to all connected users
                users = users.filter((user)=>{
                    try {
                        user.send(JSON.stringify(parsedEvent));
                        return true;
                    } catch  {
                        return false;
                    }
                });
                // Fetch AI response from Groq
                const aiResponse = await fetchAIResponse(parsedEvent.data.message);
                // Send the AI response to all connected users
                const aiMessage = {
                    type: "message",
                    data: {
                        name: "Groq AI",
                        message: aiResponse
                    }
                };
                users = users.filter((user)=>{
                    try {
                        user.send(JSON.stringify(aiMessage));
                        return true;
                    } catch  {
                        return false;
                    }
                });
                console.log(`There ${users.length === 1 ? "is" : "are"} ${users.length} ${users.length === 1 ? "user" : "users"} online`);
            }
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS9ydW5uZXIvV2ViLUNoYXQvc2VydmVyLnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHNlcnZlIH0gZnJvbSBcImh0dHBzOi8vZGVuby5sYW5kL3N0ZEAwLjc1LjAvaHR0cC9zZXJ2ZXIudHNcIlxuaW1wb3J0IHsgYWNjZXB0V2ViU29ja2V0LCBXZWJTb2NrZXQgfSBmcm9tIFwiaHR0cHM6Ly9kZW5vLmxhbmQvc3RkQDAuNzUuMC93cy9tb2QudHNcIlxuXG5jb25zdCBzZXJ2ZXIgPSBzZXJ2ZShcIjo4MDgwXCIpXG5jb25zb2xlLmxvZyhgQ2hhdCBzZXJ2ZXIgaXMgcnVubmluZyBvbiA4MDgwYClcbmNvbnN0IGNsaWVudCA9IERlbm8uZW52LmdldCgnR1JPUV9BUElfS0VZJyk7XG5cbmxldCB1c2VyczogV2ViU29ja2V0W10gPSBbXVxuXG5hc3luYyBmdW5jdGlvbiBmZXRjaEFJUmVzcG9uc2UodXNlck1lc3NhZ2U6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgY29uc3QgcHJvbXB0ID0gYFJlc3BvbnNlIHRvOiAke3VzZXJNZXNzYWdlfWBcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFwiaHR0cHM6Ly9hcGkuZ3JvcS5haS9nZW5lcmF0ZS1yZXNwb25zZVwiLCB7XG4gICAgICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgICAgICAgICAgXCJBdXRob3JpemF0aW9uXCI6IGBCZWFyZXIgJHtjbGllbnR9YFxuICAgICAgICB9LFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICBtZXNzYWdlczogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgcm9sZTogJ3N5c3RlbScsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRlbnQ6IHByb21wdCxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgcm9sZTogJ3VzZXInLFxuICAgICAgICAgICAgICAgICAgICBjb250ZW50OiBwcm9tcHQsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBtb2RlbDogJ21peHRyYWwtOHg3Yi0zMjc2OCcsXG4gICAgICAgICAgICB0ZW1wZXJhdHVyZTogMC41LFxuICAgICAgICAgICAgbWF4X3Rva2VuczogMTAyNCxcbiAgICAgICAgICAgIHRvcF9wOiAxLFxuICAgICAgICAgICAgc3RvcDogbnVsbCxcbiAgICAgICAgICAgIHN0cmVhbTogZmFsc2VcbiAgICAgICAgfSlcbiAgICB9KTtcblxuICAgIGlmIChyZXNwb25zZS5vaykge1xuICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xuICAgICAgICByZXR1cm4gZGF0YS5jaG9pY2VzWzBdPy5tZXNzYWdlPy5jb250ZW50IHx8IFwiU29ycnksIEkgY291bGRuJ3QgdW5kZXJzdGFuZCB0aGF0LlwiO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJFcnJvciBmZXRjaGluZyBBSSByZXNwb25zZTpcIiwgcmVzcG9uc2Uuc3RhdHVzVGV4dCk7XG4gICAgICAgIHJldHVybiBcIlNvcnJ5LCBzb21ldGhpbmcgd2VudCB3cm9uZy5cIjtcbiAgICB9XG59XG5cbmZvciBhd2FpdCAoY29uc3QgcmVxIG9mIHNlcnZlcikge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHsgY29ubiwgcjogYnVmUmVhZGVyLCB3OiBidWZXcml0ZXIsIGhlYWRlcnMgfSA9IHJlcVxuICAgICAgICBsZXQgc29ja2V0ID0gYXdhaXQgYWNjZXB0V2ViU29ja2V0KHtcbiAgICAgICAgICAgIGNvbm4sXG4gICAgICAgICAgICBidWZSZWFkZXIsXG4gICAgICAgICAgICBidWZXcml0ZXIsXG4gICAgICAgICAgICBoZWFkZXJzLFxuICAgICAgICB9KVxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBoYW5kbGVXcyhzb2NrZXQpXG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcihgZmFpbGVkIHRvIHJlY2VpdmUgZnJhbWU6ICR7ZXJyfWApXG5cbiAgICAgICAgICAgIGlmICghc29ja2V0LmlzQ2xvc2VkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgc29ja2V0LmNsb3NlKDEwMDApLmNhdGNoKGNvbnNvbGUuZXJyb3IpXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBsZXQgaGVhZGVycyA9IG5ldyBIZWFkZXJzKClcbiAgICAgICAgICAgIGxldCBkYXRhXG5cbiAgICAgICAgICAgIGlmIChyZXEudXJsID09PSBcIi9cIiB8fCByZXEudXJsID09PSBcIi9pbmRleC5odG1sXCIpIHtcbiAgICAgICAgICAgICAgICBoZWFkZXJzLnNldChcIkNvbnRlbnQtVHlwZVwiLCBcInRleHQvaHRtbFwiKVxuICAgICAgICAgICAgICAgIGRhdGEgPSBhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShcImluZGV4Lmh0bWxcIilcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVxLnVybCA9PT0gXCIvc3R5bGVzLmNzc1wiKSB7XG4gICAgICAgICAgICAgICAgaGVhZGVycy5zZXQoXCJDb250ZW50LVR5cGVcIiwgXCJ0ZXh0L2Nzc1wiKVxuICAgICAgICAgICAgICAgIGRhdGEgPSBhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShcInN0eWxlcy5jc3NcIilcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVxLnVybCA9PT0gXCIvZnJvbnRlbmQuanNcIikge1xuICAgICAgICAgICAgICAgIGhlYWRlcnMuc2V0KFwiQ29udGVudC1UeXBlXCIsIFwidGV4dC9qYXZhc2NyaXB0XCIpXG4gICAgICAgICAgICAgICAgZGF0YSA9IGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKFwiZnJvbnRlbmQuanNcIilcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgNDA0XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHJlcS5yZXNwb25kKHsgc3RhdHVzOiAyMDAsIGJvZHk6IGRhdGEsIGhlYWRlcnM6IGhlYWRlcnMgfSlcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICBhd2FpdCByZXEucmVzcG9uZCh7IHN0YXR1czogNDA0IH0pXG4gICAgICAgIH1cbiAgICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVdzKHNvY2tldDogV2ViU29ja2V0KSB7XG4gICAgZm9yIGF3YWl0IChjb25zdCBldmVudCBvZiBzb2NrZXQpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBldmVudCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgY29uc3QgcGFyc2VkRXZlbnQgPSBKU09OLnBhcnNlKGV2ZW50KVxuICAgICAgICAgICAgaWYgKHBhcnNlZEV2ZW50LnR5cGUgPT09IFwib3BlblwiKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coXCJDb25uZWN0aW9uIGVzdGFibGlzaGVkIHdpdGggYSBjbGllbnQuXCIpXG4gICAgICAgICAgICAgICAgdXNlcnMucHVzaChzb2NrZXQpXG5cbiAgICAgICAgICAgICAgICBhd2FpdCBzb2NrZXQuc2VuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgICAgICAgIHR5cGU6IFwibWVzc2FnZVwiLFxuICAgICAgICAgICAgICAgICAgICBkYXRhOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcIlNFUlZFUlwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgbWVzc2FnZTogXCJIZWxsbywgd2VsY29tZSB0byB0aGUgd2ViY2hhdCFcIlxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSkpXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHBhcnNlZEV2ZW50LnR5cGUgPT09IFwibWVzc2FnZVwiKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5kaXIocGFyc2VkRXZlbnQpXG5cbiAgICAgICAgICAgICAgICAvLyBCcm9hZGNhc3QgdGhlIHVzZXIncyBtZXNzYWdlIHRvIGFsbCBjb25uZWN0ZWQgdXNlcnNcbiAgICAgICAgICAgICAgICB1c2VycyA9IHVzZXJzLmZpbHRlcih1c2VyID0+IHtcbiAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHVzZXIuc2VuZChKU09OLnN0cmluZ2lmeShwYXJzZWRFdmVudCkpXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZVxuICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSlcblxuICAgICAgICAgICAgICAgIC8vIEZldGNoIEFJIHJlc3BvbnNlIGZyb20gR3JvcVxuICAgICAgICAgICAgICAgIGNvbnN0IGFpUmVzcG9uc2UgPSBhd2FpdCBmZXRjaEFJUmVzcG9uc2UocGFyc2VkRXZlbnQuZGF0YS5tZXNzYWdlKVxuXG4gICAgICAgICAgICAgICAgLy8gU2VuZCB0aGUgQUkgcmVzcG9uc2UgdG8gYWxsIGNvbm5lY3RlZCB1c2Vyc1xuICAgICAgICAgICAgICAgIGNvbnN0IGFpTWVzc2FnZSA9IHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJtZXNzYWdlXCIsXG4gICAgICAgICAgICAgICAgICAgIGRhdGE6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiR3JvcSBBSVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgbWVzc2FnZTogYWlSZXNwb25zZVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdXNlcnMgPSB1c2Vycy5maWx0ZXIodXNlciA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB1c2VyLnNlbmQoSlNPTi5zdHJpbmdpZnkoYWlNZXNzYWdlKSlcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlXG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KVxuXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFRoZXJlICR7dXNlcnMubGVuZ3RoID09PSAxID8gXCJpc1wiIDogXCJhcmVcIn0gJHt1c2Vycy5sZW5ndGh9ICR7dXNlcnMubGVuZ3RoID09PSAxID8gXCJ1c2VyXCIgOiBcInVzZXJzXCJ9IG9ubGluZWApXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsU0FBUyxLQUFLLFFBQVEsOENBQTZDO0FBQ25FLFNBQVMsZUFBZSxRQUFtQix5Q0FBd0M7QUFFbkYsTUFBTSxTQUFTLE1BQU07QUFDckIsUUFBUSxHQUFHLENBQUMsQ0FBQyw4QkFBOEIsQ0FBQztBQUM1QyxNQUFNLFNBQVMsS0FBSyxHQUFHLENBQUMsR0FBRyxDQUFDO0FBRTVCLElBQUksUUFBcUIsRUFBRTtBQUUzQixlQUFlLGdCQUFnQixXQUFtQixFQUFtQjtJQUNqRSxNQUFNLFNBQVMsQ0FBQyxhQUFhLEVBQUUsWUFBWSxDQUFDO0lBQzVDLE1BQU0sV0FBVyxNQUFNLE1BQU0seUNBQXlDO1FBQ2xFLFFBQVE7UUFDUixTQUFTO1lBQ0wsZ0JBQWdCO1lBQ2hCLGlCQUFpQixDQUFDLE9BQU8sRUFBRSxPQUFPLENBQUM7UUFDdkM7UUFDQSxNQUFNLEtB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