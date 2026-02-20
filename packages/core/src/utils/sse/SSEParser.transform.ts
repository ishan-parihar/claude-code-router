export class SSEParserTransform extends TransformStream<string, any> {
    private buffer = '';
    private currentEvent: Record<string, any> = {};

    constructor() {
        super({
            transform: (chunk: string, controller) => {
                this.buffer += chunk;
                const lines = this.buffer.split('\n');

                // Keep last line (may be incomplete)
                this.buffer = lines.pop() || '';

                for (const line of lines) {
                    const event = this.processLine(line);
                    if (event) {
                        controller.enqueue(event);
                    }
                }
            },
            flush: (controller) => {
                // Process remaining content in buffer
                if (this.buffer.trim()) {
                    const events: any[] = [];
                    this.processLine(this.buffer.trim(), events);
                    events.forEach(event => controller.enqueue(event));
                }

                // Push last event (if any)
                if (Object.keys(this.currentEvent).length > 0) {
                    controller.enqueue(this.currentEvent);
                }
            }
        });
    }

    private processLine(line: string, events?: any[]): any | null {
        // Handle SSE comments (e.g., :ping heartbeats)
        if (line.startsWith(':')) {
            const comment = { type: 'comment', data: line.slice(1).trim() };
            if (events) {
                events.push(comment);
                return null;
            }
            return comment;
        }

        if (!line.trim()) {
            if (Object.keys(this.currentEvent).length > 0) {
                const event = { ...this.currentEvent };
                this.currentEvent = {};
                if (events) {
                    events.push(event);
                    return null;
                }
                return event;
            }
            return null;
        }

        if (line.startsWith('event:')) {
            this.currentEvent.event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            let data = line.slice(5).trim();
            
            // Handle case where SSE comment (like :ping) got concatenated to data
            // This can happen if a heartbeat was sent without proper line separation
            const commentIndex = data.indexOf('\n:');
            if (commentIndex === -1) {
                // Also check for :ping at the end of the line (no newline)
                const pingIndex = data.indexOf(':ping');
                if (pingIndex !== -1) {
                    data = data.substring(0, pingIndex).trim();
                }
            }
            
            if (data === '[DONE]') {
                this.currentEvent.data = { type: 'done' };
            } else {
                try {
                    this.currentEvent.data = JSON.parse(data);
                } catch (e) {
                    this.currentEvent.data = { raw: data, error: 'JSON parse failed' };
                }
            }
        } else if (line.startsWith('id:')) {
            this.currentEvent.id = line.slice(3).trim();
        } else if (line.startsWith('retry:')) {
            this.currentEvent.retry = parseInt(line.slice(6).trim());
        }
        return null;
    }
}
