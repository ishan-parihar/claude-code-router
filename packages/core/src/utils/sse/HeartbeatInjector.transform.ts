export class HeartbeatInjectorTransform extends TransformStream<string, string> {
    constructor(intervalMs: number = 30000) {
        let timer: NodeJS.Timeout | null = null;
        let controller: TransformStreamDefaultController<string>;

        super({
            start(ctrl) {
                controller = ctrl;
                timer = setInterval(() => {
                    try {
                        // Inject :ping comment as a serialized SSE event part
                        // The SSESerializer expects objects, but if we are injecting *after* serialization
                        // (which we are, based on the plan), we are injecting raw strings into the serialized stream.
                        // Wait, looking at index.ts:
                        // resultStream = rewriteStream(...).pipeThrough(new SSESerializerTransform());
                        // So SSESerializerTransform outputs strings.
                        // We should inject the string ':ping\n\n'.
                        controller.enqueue(':ping\n\n');
                    } catch {
                        // Stream likely closed
                        if (timer) clearInterval(timer);
                    }
                }, intervalMs);
            },
            transform(chunk, ctrl) {
                ctrl.enqueue(chunk);
            },
            flush() {
                if (timer) clearInterval(timer);
            }
        });
    }
}
