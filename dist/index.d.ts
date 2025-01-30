declare const SlackClientInterface: {
    start: (runtime: any) => Promise<any>;
    stop: (_runtime: any) => Promise<void>;
};

export { SlackClientInterface, SlackClientInterface as default };
