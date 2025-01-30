import { SlackClient } from "./slack-client";

export const SlackClientInterface = {
    start: async (runtime: any) => {
        const client = new SlackClient(runtime);
        await client.start();
        return client as any;
    },
    stop: async (_runtime: any) => {
        console.warn("Slack client stopping...");
    },
};
export default SlackClientInterface;
