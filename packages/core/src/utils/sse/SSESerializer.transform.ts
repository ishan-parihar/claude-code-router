export class SSESerializerTransform extends TransformStream<any, string> {
    constructor() {
        super({
            transform: (event, controller) => {
                // Handle comment events (heartbeats)
                if (event.type === 'comment') {
                    controller.enqueue(`:${event.data}\n\n`);
                    return;
                }

                let output = '';

                if (event.event) {
                    output += `event: ${event.event}\n`;
                }
                if (event.id) {
                    output += `id: ${event.id}\n`;
                }
                if (event.retry) {
                    output += `retry: ${event.retry}\n`;
                }
                if (event.data) {
                    if (event.data.type === 'done') {
                        output += 'data: [DONE]\n';
                    } else {
                        output += `data: ${JSON.stringify(event.data)}\n`;
                    }
                }

                output += '\n';
                controller.enqueue(output);
            }
        });
    }
}
