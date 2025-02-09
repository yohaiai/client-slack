import { SlackClientInterface } from "./client";

const slackPlugin = {
    name: "slack",
    description: "Slack client plugin",
    clients: [SlackClientInterface],
};
export default slackPlugin;
