declare const SlackClientInterface: {
    name: string;
    config: {};
    start: (runtime: any) => Promise<any>;
    stop: (_runtime: any) => Promise<void>;
};

export { SlackClientInterface, SlackClientInterface as default };
