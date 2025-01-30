// src/slack-client.ts
import { elizaLogger as elizaLogger4 } from "@elizaos/core";
import { WebClient as WebClient2 } from "@slack/web-api";
import express from "express";
import { EventEmitter } from "events";

// src/messages.ts
import {
  stringToUuid,
  getEmbeddingZeroVector,
  composeContext,
  generateMessageResponse,
  generateShouldRespond,
  ModelClass,
  elizaLogger
} from "@elizaos/core";

// src/templates.ts
import { messageCompletionFooter, shouldRespondFooter } from "@elizaos/core";
var slackShouldRespondTemplate = `# Task: Decide if {{agentName}} should respond.
About {{agentName}}:
{{bio}}

# INSTRUCTIONS: Determine if {{agentName}} should respond to the message and participate in the conversation. Do not comment. Just respond with "RESPOND" or "IGNORE" or "STOP".

# RESPONSE EXAMPLES
<user 1>: Hey everyone, what's up?
<user 2>: Not much, just working
Result: [IGNORE]

{{agentName}}: I can help with that task
<user 1>: thanks!
<user 2>: @{{agentName}} can you explain more?
Result: [RESPOND]

<user>: @{{agentName}} shut up
Result: [STOP]

<user>: Hey @{{agentName}}, can you help me with something?
Result: [RESPOND]

<user>: @{{agentName}} please stop
Result: [STOP]

<user>: I need help
{{agentName}}: How can I help you?
<user>: Not you, I need someone else
Result: [IGNORE]

Response options are [RESPOND], [IGNORE] and [STOP].

{{agentName}} is in a Slack channel with other users and is very mindful about not being disruptive.
Respond with [RESPOND] to messages that:
- Directly mention @{{agentName}}
- Are follow-ups to {{agentName}}'s previous messages
- Are relevant to ongoing conversations {{agentName}} is part of

Respond with [IGNORE] to messages that:
- Are not directed at {{agentName}}
- Are general channel chatter
- Are very short or lack context
- Are part of conversations {{agentName}} isn't involved in

Respond with [STOP] when:
- Users explicitly ask {{agentName}} to stop or be quiet
- The conversation with {{agentName}} has naturally concluded
- Users express frustration with {{agentName}}

IMPORTANT: {{agentName}} should err on the side of [IGNORE] if there's any doubt about whether to respond.
Only respond when explicitly mentioned or when clearly part of an ongoing conversation.

{{recentMessages}}

# INSTRUCTIONS: Choose the option that best describes {{agentName}}'s response to the last message. Ignore messages if they are not directed at {{agentName}}.
` + shouldRespondFooter;
var slackMessageHandlerTemplate = `# Action Examples
{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
{{knowledge}}

# Task: Generate dialog and actions for the character {{agentName}} in Slack.
About {{agentName}}:
{{bio}}
{{lore}}

Examples of {{agentName}}'s dialog and actions:
{{characterMessageExamples}}

{{providers}}

{{attachments}}

{{actions}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

# Conversation Flow Rules
1. Only continue the conversation if the user has explicitly mentioned {{agentName}} or is directly responding to {{agentName}}'s last message
2. Do not use the CONTINUE action unless explicitly asked to continue by the user
3. Wait for user input before generating additional responses
4. Keep responses focused and concise
5. If a conversation is naturally concluding, let it end gracefully

{{messageDirections}}

{{recentMessages}}

# Instructions: Write the next message for {{agentName}}. Include an action, if appropriate. {{actionNames}}
Remember to follow the conversation flow rules above.
` + messageCompletionFooter;

// src/messages.ts
var MessageManager = class {
  client;
  runtime;
  botUserId;
  processedEvents = /* @__PURE__ */ new Set();
  messageProcessingLock = /* @__PURE__ */ new Set();
  processedMessages = /* @__PURE__ */ new Map();
  constructor(client, runtime, botUserId) {
    console.log("\u{1F4F1} Initializing MessageManager...");
    this.client = client;
    this.runtime = runtime;
    this.botUserId = botUserId;
    console.log("MessageManager initialized with botUserId:", botUserId);
    setInterval(() => {
      const oneHourAgo = Date.now() - 36e5;
      for (const [key, timestamp] of this.processedMessages.entries()) {
        if (timestamp < oneHourAgo) {
          this.processedMessages.delete(key);
        }
      }
      this.processedEvents.clear();
    }, 36e5);
  }
  generateEventKey(event) {
    const eventType = event.type === "app_mention" ? "message" : event.type;
    const components = [
      event.ts,
      // Timestamp
      event.channel,
      // Channel ID
      eventType,
      // Normalized event type
      event.user,
      // User ID
      event.thread_ts
      // Thread timestamp (if any)
    ].filter(Boolean);
    const key = components.join("-");
    console.log("\n=== EVENT DETAILS ===");
    console.log("Event Type:", event.type);
    console.log("Event TS:", event.ts);
    console.log("Channel:", event.channel);
    console.log("User:", event.user);
    console.log("Thread TS:", event.thread_ts);
    console.log("Generated Key:", key);
    return key;
  }
  cleanMessage(text) {
    elizaLogger.debug("\u{1F9F9} [CLEAN] Cleaning message text:", text);
    const cleaned = text.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim();
    elizaLogger.debug("\u2728 [CLEAN] Cleaned result:", cleaned);
    return cleaned;
  }
  async _shouldRespond(message, state) {
    var _a, _b, _c, _d;
    console.log("\n=== SHOULD_RESPOND PHASE ===");
    console.log("\u{1F50D} Step 1: Evaluating if should respond to message");
    if (message.type === "app_mention" || ((_a = message.text) == null ? void 0 : _a.includes(`<@${this.botUserId}>`))) {
      console.log("\u2705 Direct mention detected - will respond");
      return true;
    }
    if (message.channel_type === "im") {
      console.log("\u2705 Direct message detected - will respond");
      return true;
    }
    if (message.thread_ts && ((_b = state.recentMessages) == null ? void 0 : _b.includes(this.runtime.agentId))) {
      console.log("\u2705 Active thread participant - will respond");
      return true;
    }
    console.log("\u{1F914} Step 2: Using LLM to decide response");
    const shouldRespondContext = composeContext({
      state,
      template: ((_c = this.runtime.character.templates) == null ? void 0 : _c.slackShouldRespondTemplate) || ((_d = this.runtime.character.templates) == null ? void 0 : _d.shouldRespondTemplate) || slackShouldRespondTemplate
    });
    console.log("\u{1F504} Step 3: Calling generateShouldRespond");
    const response = await generateShouldRespond({
      runtime: this.runtime,
      context: shouldRespondContext,
      modelClass: ModelClass.SMALL
    });
    console.log(`\u2705 Step 4: LLM decision received: ${response}`);
    return response === "RESPOND";
  }
  async _generateResponse(memory, state, context) {
    var _a, _b;
    console.log("\n=== GENERATE_RESPONSE PHASE ===");
    console.log("\u{1F50D} Step 1: Starting response generation");
    console.log("\u{1F504} Step 2: Calling LLM for response");
    const response = await generateMessageResponse({
      runtime: this.runtime,
      context,
      modelClass: ModelClass.LARGE
    });
    console.log("\u2705 Step 3: LLM response received");
    if (!response) {
      console.error("\u274C No response from generateMessageResponse");
      return {
        text: "I apologize, but I'm having trouble generating a response right now.",
        source: "slack"
      };
    }
    if (response.action === "CONTINUE" && !((_a = memory.content.text) == null ? void 0 : _a.includes(`<@${this.botUserId}>`)) && !((_b = state.recentMessages) == null ? void 0 : _b.includes(memory.id))) {
      console.log(
        "\u26A0\uFE0F Step 4: Removing CONTINUE action - not a direct interaction"
      );
      delete response.action;
    }
    console.log("\u2705 Step 5: Returning generated response");
    return response;
  }
  async handleMessage(event) {
    var _a;
    console.log("\n=== MESSAGE_HANDLING PHASE ===");
    console.log("\u{1F50D} Step 1: Received new message event");
    if (!event || !event.ts || !event.channel) {
      console.log("\u26A0\uFE0F Invalid event data - skipping");
      return;
    }
    const eventKey = this.generateEventKey(event);
    if (this.processedEvents.has(eventKey)) {
      console.log("\u26A0\uFE0F Event already processed - skipping");
      console.log("Existing event key:", eventKey);
      console.log("Original event type:", event.type);
      console.log("Duplicate prevention working as expected");
      return;
    }
    console.log("\u2705 New event - processing:", eventKey);
    console.log("Event type being processed:", event.type);
    this.processedEvents.add(eventKey);
    const messageKey = eventKey;
    const currentTime = Date.now();
    try {
      if (this.messageProcessingLock.has(messageKey)) {
        console.log(
          "\u26A0\uFE0F Message is currently being processed - skipping"
        );
        return;
      }
      console.log("\u{1F512} Step 2: Adding message to processing lock");
      this.messageProcessingLock.add(messageKey);
      try {
        if (event.bot_id || event.user === this.botUserId) {
          console.log("\u26A0\uFE0F Message from bot or self - skipping");
          return;
        }
        console.log("\u{1F9F9} Step 3: Cleaning message text");
        const cleanedText = this.cleanMessage(event.text || "");
        if (!cleanedText) {
          console.log("\u26A0\uFE0F Empty message after cleaning - skipping");
          return;
        }
        console.log("\u{1F511} Step 4: Generating conversation IDs");
        const roomId = stringToUuid(
          `${event.channel}-${this.runtime.agentId}`
        );
        const userId = stringToUuid(
          `${event.user}-${this.runtime.agentId}`
        );
        const messageId = stringToUuid(
          `${event.ts}-${this.runtime.agentId}`
        );
        console.log("\u{1F4BE} Step 5: Creating initial memory");
        const content = {
          text: cleanedText,
          source: "slack",
          inReplyTo: event.thread_ts ? stringToUuid(
            `${event.thread_ts}-${this.runtime.agentId}`
          ) : void 0,
          attachments: event.text ? [
            {
              id: stringToUuid(`${event.ts}-attachment`),
              url: "",
              // Since this is text content, no URL is needed
              title: "Text Attachment",
              source: "slack",
              description: "Text content from Slack message",
              text: cleanedText
            }
          ] : void 0
        };
        const memory = {
          id: messageId,
          userId,
          agentId: this.runtime.agentId,
          roomId,
          content,
          createdAt: new Date(parseFloat(event.ts) * 1e3).getTime(),
          embedding: getEmbeddingZeroVector()
        };
        if (content.text) {
          console.log("\u{1F4BE} Step 6: Saving initial memory");
          await this.runtime.messageManager.createMemory(memory);
        }
        console.log("\u{1F504} Step 7: Composing initial state");
        let state = await this.runtime.composeState(
          { content, userId, agentId: this.runtime.agentId, roomId },
          {
            slackClient: this.client,
            slackEvent: event,
            agentName: this.runtime.character.name,
            senderName: event.user_name || event.user
          }
        );
        console.log("\u{1F504} Step 8: Updating state with recent messages");
        state = await this.runtime.updateRecentMessageState(state);
        console.log("\u{1F914} Step 9: Checking if we should respond");
        const shouldRespond = await this._shouldRespond(event, state);
        if (shouldRespond) {
          console.log(
            "\u2705 Step 10: Should respond - generating response"
          );
          const context = composeContext({
            state,
            template: ((_a = this.runtime.character.templates) == null ? void 0 : _a.slackMessageHandlerTemplate) || slackMessageHandlerTemplate
          });
          const responseContent = await this._generateResponse(
            memory,
            state,
            context
          );
          if (responseContent == null ? void 0 : responseContent.text) {
            console.log("\u{1F4E4} Step 11: Preparing to send response");
            const callback = async (content2) => {
              try {
                console.log(
                  " Step 12: Executing response callback"
                );
                const result = await this.client.chat.postMessage({
                  channel: event.channel,
                  text: content2.text || responseContent.text,
                  thread_ts: event.thread_ts
                });
                console.log(
                  "\u{1F4BE} Step 13: Creating response memory"
                );
                const responseMemory = {
                  id: stringToUuid(
                    `${result.ts}-${this.runtime.agentId}`
                  ),
                  userId: this.runtime.agentId,
                  agentId: this.runtime.agentId,
                  roomId,
                  content: {
                    ...content2,
                    text: content2.text || responseContent.text,
                    inReplyTo: messageId
                  },
                  createdAt: Date.now(),
                  embedding: getEmbeddingZeroVector()
                };
                console.log(
                  "\u2713 Step 14: Marking message as processed"
                );
                this.processedMessages.set(
                  messageKey,
                  currentTime
                );
                console.log(
                  "\u{1F4BE} Step 15: Saving response memory"
                );
                await this.runtime.messageManager.createMemory(
                  responseMemory
                );
                return [responseMemory];
              } catch (error) {
                console.error("\u274C Error in callback:", error);
                return [];
              }
            };
            console.log("\u{1F4E4} Step 16: Sending initial response");
            const responseMessages = await callback(responseContent);
            console.log(
              "\u{1F504} Step 17: Updating state after response"
            );
            state = await this.runtime.updateRecentMessageState(state);
            if (responseContent.action) {
              console.log("\u26A1 Step 18: Processing actions");
              await this.runtime.processActions(
                memory,
                responseMessages,
                state,
                callback
              );
            }
          }
        } else {
          console.log("\u23ED\uFE0F Should not respond - skipping");
          this.processedMessages.set(messageKey, currentTime);
        }
      } finally {
        console.log(
          "\u{1F513} Final Step: Removing message from processing lock"
        );
        this.messageProcessingLock.delete(messageKey);
      }
    } catch (error) {
      console.error("\u274C Error in message handling:", error);
      this.messageProcessingLock.delete(messageKey);
    }
  }
};

// src/environment.ts
import { elizaLogger as elizaLogger2 } from "@elizaos/core";
import { z } from "zod";
var slackEnvSchema = z.object({
  SLACK_APP_ID: z.string().min(1, "Slack application ID is required"),
  SLACK_CLIENT_ID: z.string().min(1, "Slack client ID is required"),
  SLACK_CLIENT_SECRET: z.string().min(1, "Slack client secret is required"),
  SLACK_SIGNING_SECRET: z.string().min(1, "Slack signing secret is required"),
  SLACK_VERIFICATION_TOKEN: z.string().min(1, "Slack verification token is required"),
  SLACK_BOT_TOKEN: z.string().min(1, "Slack bot token is required"),
  SLACK_SERVER_PORT: z.string().optional().transform((val) => val ? parseInt(val) : 3e3)
});
async function validateSlackConfig(runtime) {
  try {
    elizaLogger2.debug(
      "Validating Slack configuration with runtime settings"
    );
    const config = {
      SLACK_APP_ID: runtime.getSetting("SLACK_APP_ID") || process.env.SLACK_APP_ID,
      SLACK_CLIENT_ID: runtime.getSetting("SLACK_CLIENT_ID") || process.env.SLACK_CLIENT_ID,
      SLACK_CLIENT_SECRET: runtime.getSetting("SLACK_CLIENT_SECRET") || process.env.SLACK_CLIENT_SECRET,
      SLACK_SIGNING_SECRET: runtime.getSetting("SLACK_SIGNING_SECRET") || process.env.SLACK_SIGNING_SECRET,
      SLACK_VERIFICATION_TOKEN: runtime.getSetting("SLACK_VERIFICATION_TOKEN") || process.env.SLACK_VERIFICATION_TOKEN,
      SLACK_BOT_TOKEN: runtime.getSetting("SLACK_BOT_TOKEN") || process.env.SLACK_BOT_TOKEN,
      SLACK_SERVER_PORT: runtime.getSetting("SLACK_SERVER_PORT") || process.env.SLACK_SERVER_PORT
    };
    elizaLogger2.debug("Parsing configuration with schema", config);
    const validated = slackEnvSchema.parse(config);
    elizaLogger2.debug("Configuration validated successfully");
    return validated;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("\n");
      elizaLogger2.error(
        "Configuration validation failed:",
        errorMessages
      );
      throw new Error(
        `Slack configuration validation failed:
${errorMessages}`
      );
    }
    throw error;
  }
}

// src/actions/chat_with_attachments.ts
import {
  composeContext as composeContext2,
  generateText,
  trimTokens,
  parseJSONObjectFromText,
  getModelSettings
} from "@elizaos/core";
import {
  ModelClass as ModelClass2
} from "@elizaos/core";
var summarizationTemplate = `# Summarized so far (we are adding to this)
{{currentSummary}}

# Current attachments we are summarizing
{{attachmentsWithText}}

Summarization objective: {{objective}}

# Instructions: Summarize the attachments. Return the summary. Do not acknowledge this request, just summarize and continue the existing summary if there is one. Capture any important details based on the objective. Only respond with the new summary text.`;
var attachmentIdsTemplate = `# Messages we are summarizing
{{recentMessages}}

# Instructions: {{senderName}} is requesting a summary of specific attachments. Your goal is to determine their objective, along with the list of attachment IDs to summarize.
The "objective" is a detailed description of what the user wants to summarize based on the conversation.
The "attachmentIds" is an array of attachment IDs that the user wants to summarize. If not specified, default to including all attachments from the conversation.

Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "objective": "<What the user wants to summarize>",
  "attachmentIds": ["<Attachment ID 1>", "<Attachment ID 2>", ...]
}
\`\`\`
`;
var getAttachmentIds = async (runtime, message, state) => {
  const context = composeContext2({
    state,
    template: attachmentIdsTemplate
  });
  for (let i = 0; i < 5; i++) {
    const response = await generateText({
      runtime,
      context,
      modelClass: ModelClass2.SMALL
    });
    const parsedResponse = parseJSONObjectFromText(response);
    if ((parsedResponse == null ? void 0 : parsedResponse.objective) && (parsedResponse == null ? void 0 : parsedResponse.attachmentIds)) {
      return parsedResponse;
    }
  }
  return null;
};
var summarizeAction = {
  name: "CHAT_WITH_ATTACHMENTS",
  similes: [
    "CHAT_WITH_ATTACHMENT",
    "SUMMARIZE_FILES",
    "SUMMARIZE_FILE",
    "SUMMARIZE_ATACHMENT",
    "CHAT_WITH_PDF",
    "ATTACHMENT_SUMMARY",
    "RECAP_ATTACHMENTS",
    "SUMMARIZE_FILE",
    "SUMMARIZE_VIDEO",
    "SUMMARIZE_AUDIO",
    "SUMMARIZE_IMAGE",
    "SUMMARIZE_DOCUMENT",
    "SUMMARIZE_LINK",
    "ATTACHMENT_SUMMARY",
    "FILE_SUMMARY"
  ],
  description: "Answer a user request informed by specific attachments based on their IDs. If a user asks to chat with a PDF, or wants more specific information about a link or video or anything else they've attached, this is the action to use.",
  validate: async (runtime, message, _state) => {
    if (message.content.source !== "slack") {
      return false;
    }
    const keywords = [
      "attachment",
      "summary",
      "summarize",
      "research",
      "pdf",
      "video",
      "audio",
      "image",
      "document",
      "link",
      "file",
      "attachment",
      "summarize",
      "code",
      "report",
      "write",
      "details",
      "information",
      "talk",
      "chat",
      "read",
      "listen",
      "watch"
    ];
    return keywords.some(
      (keyword) => message.content.text.toLowerCase().includes(keyword.toLowerCase())
    );
  },
  handler: async (runtime, message, state, options, callback) => {
    var _a, _b;
    const currentState = state ?? await runtime.composeState(message);
    const callbackData = {
      text: "",
      action: "CHAT_WITH_ATTACHMENTS_RESPONSE",
      source: message.content.source,
      attachments: []
    };
    const attachmentData = await getAttachmentIds(
      runtime,
      message,
      currentState
    );
    if (!attachmentData) {
      console.error("Couldn't get attachment IDs from message");
      await callback(callbackData);
      return callbackData;
    }
    const { objective, attachmentIds } = attachmentData;
    const attachments = currentState.recentMessagesData.filter(
      (msg) => msg.content.attachments && msg.content.attachments.length > 0
    ).flatMap((msg) => msg.content.attachments).filter((attachment) => {
      if (!attachment) return false;
      return attachmentIds.map((attch) => attch.toLowerCase().slice(0, 5)).includes(attachment.id.toLowerCase().slice(0, 5)) || attachmentIds.some((id) => {
        const attachmentId = id.toLowerCase().slice(0, 5);
        return attachment.id.toLowerCase().includes(attachmentId);
      });
    });
    const attachmentsWithText = attachments.map((attachment) => {
      if (!attachment) return "";
      return `# ${attachment.title}
${attachment.text}`;
    }).filter((text) => text !== "").join("\n\n");
    let currentSummary = "";
    const modelSettings = getModelSettings(
      runtime.character.modelProvider,
      ModelClass2.SMALL
    );
    const chunkSize = modelSettings.maxOutputTokens;
    currentState.attachmentsWithText = attachmentsWithText;
    currentState.objective = objective;
    const template = await trimTokens(
      summarizationTemplate,
      chunkSize + 500,
      runtime
    );
    const context = composeContext2({
      state: currentState,
      template
    });
    const summary = await generateText({
      runtime,
      context,
      modelClass: ModelClass2.SMALL
    });
    currentSummary = currentSummary + "\n" + summary;
    if (!currentSummary) {
      console.error("No summary found!");
      await callback(callbackData);
      return callbackData;
    }
    callbackData.text = currentSummary.trim();
    if (callbackData.text && (((_a = currentSummary.trim()) == null ? void 0 : _a.split("\n").length) < 4 || ((_b = currentSummary.trim()) == null ? void 0 : _b.split(" ").length) < 100)) {
      callbackData.text = `Here is the summary:
\`\`\`md
${currentSummary.trim()}
\`\`\`
`;
      await callback(callbackData);
    } else if (currentSummary.trim()) {
      const summaryFilename = `content/summary_${Date.now()}`;
      await runtime.cacheManager.set(summaryFilename, currentSummary);
      callbackData.text = `I've attached the summary of the requested attachments as a text file.`;
      await callback(callbackData, [summaryFilename]);
    } else {
      await callback(callbackData);
    }
    return callbackData;
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Can you summarize the PDF I just shared?"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "I'll analyze the PDF and provide a summary for you.",
          action: "CHAT_WITH_ATTACHMENTS"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Could you look at these documents and tell me what they're about?"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "I'll review the documents and provide a summary of their contents.",
          action: "CHAT_WITH_ATTACHMENTS"
        }
      }
    ]
  ]
};
var chat_with_attachments_default = summarizeAction;

// src/actions/summarize_conversation.ts
import {
  composeContext as composeContext3,
  generateText as generateText2,
  splitChunks,
  trimTokens as trimTokens2,
  parseJSONObjectFromText as parseJSONObjectFromText2,
  getModelSettings as getModelSettings2
} from "@elizaos/core";
import { getActorDetails } from "@elizaos/core";
import {
  ModelClass as ModelClass3,
  elizaLogger as elizaLogger3
} from "@elizaos/core";

// src/types/slack-types.ts
import { ServiceType } from "@elizaos/core";
var SLACK_SERVICE_TYPE = ServiceType.TEXT_GENERATION;

// src/actions/summarize_conversation.ts
var summarizationTemplate2 = `# Summarized so far (we are adding to this)
{{currentSummary}}

# Current conversation chunk we are summarizing (includes attachments)
{{memoriesWithAttachments}}

Summarization objective: {{objective}}

# Instructions: Summarize the conversation so far. Return the summary. Do not acknowledge this request, just summarize and continue the existing summary if there is one. Capture any important details to the objective. Only respond with the new summary text.
Your response should be extremely detailed and include any and all relevant information.`;
var dateRangeTemplate = `# Messages we are summarizing (the conversation is continued after this)
{{recentMessages}}

# Instructions: {{senderName}} is requesting a summary of the conversation. Your goal is to determine their objective, along with the range of dates that their request covers.
The "objective" is a detailed description of what the user wants to summarize based on the conversation. If they just ask for a general summary, you can either base it off the conversation if the summary range is very recent, or set the object to be general, like "a detailed summary of the conversation between all users".

The "start" and "end" are the range of dates that the user wants to summarize, relative to the current time. The format MUST be a number followed by a unit, like:
- "5 minutes ago"
- "2 hours ago"
- "1 day ago"
- "30 seconds ago"

For example:
\`\`\`json
{
  "objective": "a detailed summary of the conversation between all users",
  "start": "2 hours ago",
  "end": "0 minutes ago"
}
\`\`\`

If the user asks for "today", use "24 hours ago" as start and "0 minutes ago" as end.
If no time range is specified, default to "2 hours ago" for start and "0 minutes ago" for end.
`;
var getDateRange = async (runtime, message, state) => {
  state = await runtime.composeState(message);
  const context = composeContext3({
    state,
    template: dateRangeTemplate
  });
  for (let i = 0; i < 5; i++) {
    const response = await generateText2({
      runtime,
      context,
      modelClass: ModelClass3.SMALL
    });
    const parsedResponse = parseJSONObjectFromText2(response);
    if ((parsedResponse == null ? void 0 : parsedResponse.objective) && (parsedResponse == null ? void 0 : parsedResponse.start) && (parsedResponse == null ? void 0 : parsedResponse.end)) {
      const parseTimeString = (timeStr) => {
        const match = timeStr.match(
          /^(\d+)\s+(second|minute|hour|day)s?\s+ago$/i
        );
        if (!match) return null;
        const [_, amount, unit] = match;
        const value = parseInt(amount);
        if (isNaN(value)) return null;
        const multipliers = {
          second: 1e3,
          minute: 60 * 1e3,
          hour: 60 * 60 * 1e3,
          day: 24 * 60 * 60 * 1e3
        };
        const multiplier = multipliers[unit.toLowerCase()];
        if (!multiplier) return null;
        return value * multiplier;
      };
      const startTime = parseTimeString(parsedResponse.start);
      const endTime = parseTimeString(parsedResponse.end);
      if (startTime === null || endTime === null) {
        elizaLogger3.error(
          "Invalid time format in response",
          parsedResponse
        );
        continue;
      }
      return {
        objective: parsedResponse.objective,
        start: Date.now() - startTime,
        end: Date.now() - endTime
      };
    }
  }
  return void 0;
};
var summarizeAction2 = {
  name: "SUMMARIZE_CONVERSATION",
  similes: [
    "RECAP",
    "RECAP_CONVERSATION",
    "SUMMARIZE_CHAT",
    "SUMMARIZATION",
    "CHAT_SUMMARY",
    "CONVERSATION_SUMMARY"
  ],
  description: "Summarizes the conversation and attachments.",
  validate: async (_runtime, message, _state) => {
    if (message.content.source !== "slack") {
      return false;
    }
    const keywords = [
      "summarize",
      "summarization",
      "summary",
      "recap",
      "report",
      "overview",
      "review",
      "rundown",
      "wrap-up",
      "brief",
      "debrief",
      "abstract",
      "synopsis",
      "outline",
      "digest",
      "abridgment",
      "condensation",
      "encapsulation",
      "essence",
      "gist",
      "main points",
      "key points",
      "key takeaways",
      "bulletpoint",
      "highlights",
      "tldr",
      "tl;dr",
      "in a nutshell",
      "bottom line",
      "long story short",
      "sum up",
      "sum it up",
      "short version",
      "bring me up to speed",
      "catch me up"
    ];
    return keywords.some(
      (keyword) => message.content.text.toLowerCase().includes(keyword.toLowerCase())
    );
  },
  handler: async (runtime, message, state, _options, callback) => {
    const currentState = await runtime.composeState(message);
    const callbackData = {
      text: "",
      action: "SUMMARIZATION_RESPONSE",
      source: message.content.source,
      attachments: []
    };
    const dateRange = await getDateRange(runtime, message, currentState);
    if (!dateRange) {
      elizaLogger3.error("Couldn't determine date range from message");
      callbackData.text = "I couldn't determine the time range to summarize. Please try asking for a specific period like 'last hour' or 'today'.";
      await callback(callbackData);
      return callbackData;
    }
    const { objective, start, end } = dateRange;
    const memories = await runtime.messageManager.getMemories({
      roomId: message.roomId,
      start,
      end,
      count: 1e4,
      unique: false
    });
    if (!memories || memories.length === 0) {
      callbackData.text = "I couldn't find any messages in that time range to summarize.";
      await callback(callbackData);
      return callbackData;
    }
    const actors = await getActorDetails({
      runtime,
      roomId: message.roomId
    });
    const actorMap = new Map(actors.map((actor) => [actor.id, actor]));
    const formattedMemories = memories.map((memory) => {
      var _a;
      const actor = actorMap.get(memory.userId);
      const userName = (actor == null ? void 0 : actor.name) || (actor == null ? void 0 : actor.username) || "Unknown User";
      const attachments = (_a = memory.content.attachments) == null ? void 0 : _a.map((attachment) => {
        if (!attachment) return "";
        return `---
Attachment: ${attachment.id}
${attachment.description || ""}
${attachment.text || ""}
---`;
      }).filter((text) => text !== "").join("\n");
      return `${userName}: ${memory.content.text}
${attachments || ""}`;
    }).join("\n");
    let currentSummary = "";
    const modelSettings = getModelSettings2(
      runtime.character.modelProvider,
      ModelClass3.SMALL
    );
    const chunkSize = modelSettings.maxOutputTokens;
    const chunks = await splitChunks(formattedMemories, chunkSize, 0);
    currentState.memoriesWithAttachments = formattedMemories;
    currentState.objective = objective;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      currentState.currentSummary = currentSummary;
      currentState.currentChunk = chunk;
      const template = await trimTokens2(
        summarizationTemplate2,
        chunkSize + 500,
        runtime
      );
      const context = composeContext3({
        state: currentState,
        template
      });
      const summary = await generateText2({
        runtime,
        context,
        modelClass: ModelClass3.SMALL
      });
      if (summary) {
        currentSummary = currentSummary + "\n" + summary;
        break;
      }
    }
    if (!currentSummary.trim()) {
      callbackData.text = "I wasn't able to generate a summary of the conversation.";
      await callback(callbackData);
      return callbackData;
    }
    const formatDate = (timestamp) => {
      const date = new Date(timestamp);
      const pad = (n) => n < 10 ? `0${n}` : n;
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    try {
      const requestingUser = actorMap.get(message.userId);
      const userName = (requestingUser == null ? void 0 : requestingUser.name) || (requestingUser == null ? void 0 : requestingUser.username) || "Unknown User";
      const summaryContent = `Summary of conversation from ${formatDate(start)} to ${formatDate(end)}

Here is a detailed summary of the conversation between ${userName} and ${runtime.character.name}:

${currentSummary.trim()}`;
      if (summaryContent.length > 1e3) {
        const summaryFilename = `summary_${Date.now()}.txt`;
        elizaLogger3.debug("Uploading summary file to Slack...");
        try {
          await runtime.cacheManager.set(
            summaryFilename,
            summaryContent
          );
          const slackService = runtime.getService(
            SLACK_SERVICE_TYPE
          );
          if (!(slackService == null ? void 0 : slackService.client)) {
            elizaLogger3.error(
              "Slack service not found or not properly initialized"
            );
            throw new Error("Slack service not found");
          }
          elizaLogger3.debug(
            `Uploading file ${summaryFilename} to channel ${message.roomId}`
          );
          const uploadResult = await slackService.client.files.upload(
            {
              channels: message.roomId,
              filename: summaryFilename,
              title: "Conversation Summary",
              content: summaryContent,
              initial_comment: `I've created a summary of the conversation from ${formatDate(start)} to ${formatDate(end)}.`
            }
          );
          if (uploadResult.ok) {
            elizaLogger3.success(
              "Successfully uploaded summary file to Slack"
            );
            callbackData.text = `I've created a summary of the conversation from ${formatDate(start)} to ${formatDate(end)}. You can find it in the thread above.`;
          } else {
            elizaLogger3.error(
              "Failed to upload file to Slack:",
              uploadResult.error
            );
            throw new Error("Failed to upload file to Slack");
          }
        } catch (error) {
          elizaLogger3.error("Error uploading summary file:", error);
          callbackData.text = summaryContent;
        }
      } else {
        callbackData.text = summaryContent;
      }
      await callback(callbackData);
      return callbackData;
    } catch (error) {
      elizaLogger3.error("Error in summary generation:", error);
      callbackData.text = "I encountered an error while generating the summary. Please try again.";
      await callback(callbackData);
      return callbackData;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Can you give me a detailed report on what we're talking about?"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "I'll analyze the conversation and provide a summary for you.",
          action: "SUMMARIZE_CONVERSATION"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Please summarize our discussion from the last hour, including any shared files."
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "I'll review the conversation and shared content to create a comprehensive summary.",
          action: "SUMMARIZE_CONVERSATION"
        }
      }
    ]
  ]
};
var summarize_conversation_default = summarizeAction2;

// src/providers/channelState.ts
var channelStateProvider = {
  get: async (runtime, message, state) => {
    const slackEvent = state == null ? void 0 : state.slackEvent;
    if (!slackEvent) {
      return "";
    }
    const agentName = (state == null ? void 0 : state.agentName) || "The agent";
    const senderName = (state == null ? void 0 : state.senderName) || "someone";
    const channelId = slackEvent.channel;
    const channelType = slackEvent.channel_type;
    if (channelType === "im") {
      return `${agentName} is currently in a direct message conversation with ${senderName}`;
    }
    let response = `${agentName} is currently having a conversation in the Slack channel <#${channelId}>`;
    if (slackEvent.thread_ts) {
      response += ` in a thread`;
    }
    if (slackEvent.team) {
      response += ` in the workspace ${slackEvent.team}`;
    }
    return response;
  }
};

// src/services/slack.service.ts
import { Service as Service2, ServiceType as ServiceType2 } from "@elizaos/core";
import { WebClient } from "@slack/web-api";
var SlackService = class extends Service2 {
  client;
  static get serviceType() {
    return ServiceType2.SLACK;
  }
  get serviceType() {
    return ServiceType2.SLACK;
  }
  async initialize(runtime) {
    const token = runtime.getSetting("SLACK_BOT_TOKEN");
    if (!token) {
      throw new Error("SLACK_BOT_TOKEN is required");
    }
    this.client = new WebClient(token);
  }
};

// src/slack-client.ts
var SlackClient = class extends EventEmitter {
  client;
  runtime;
  server;
  messageManager;
  botUserId;
  character;
  signingSecret;
  constructor(runtime) {
    super();
    elizaLogger4.log("\u{1F680} Initializing SlackClient...");
    this.runtime = runtime;
    this.character = runtime.character;
    const token = runtime.getSetting("SLACK_BOT_TOKEN");
    this.signingSecret = runtime.getSetting("SLACK_SIGNING_SECRET");
    if (!token) throw new Error("SLACK_BOT_TOKEN is required");
    if (!this.signingSecret)
      throw new Error("SLACK_SIGNING_SECRET is required");
    this.client = new WebClient2(token);
    this.server = express();
    this.server.use(express.raw({ type: "application/json" }));
    this.server.use((req, res, next) => {
      if (req.body) {
        req.rawBody = Buffer.from(req.body);
        try {
          req.body = JSON.parse(req.body.toString());
        } catch (error) {
          elizaLogger4.error(
            "\u274C [PARSE] Failed to parse request body:",
            error
          );
        }
      }
      next();
    });
  }
  async handleEvent(event) {
    var _a;
    elizaLogger4.debug("\u{1F3AF} [EVENT] Processing event:", {
      type: event.type,
      user: event.user,
      channel: event.channel,
      text: (_a = event.text) == null ? void 0 : _a.slice(0, 100)
    });
    try {
      if (event.type === "message" || event.type === "app_mention") {
        await this.messageManager.handleMessage(event);
      }
    } catch (error) {
      elizaLogger4.error("\u274C [EVENT] Error handling event:", error);
    }
  }
  async verifyPermissions() {
    elizaLogger4.debug("\u{1F512} [PERMISSIONS] Verifying bot permissions...");
    try {
      const channels = await this.client.conversations.list({
        types: "public_channel,private_channel,im,mpim"
      });
      if (!channels.ok) {
        throw new Error(`Failed to list channels: ${channels.error}`);
      }
      elizaLogger4.debug("\u{1F4CB} [PERMISSIONS] Channel access verified");
      const testMessage = await this.client.chat.postMessage({
        channel: this.botUserId,
        text: "Permission test message"
      });
      if (!testMessage.ok) {
        throw new Error(
          `Failed to send test message: ${testMessage.error}`
        );
      }
      elizaLogger4.debug("\u{1F4AC} [PERMISSIONS] Message sending verified");
      elizaLogger4.debug("\u2705 [PERMISSIONS] All permissions verified");
    } catch (error) {
      elizaLogger4.error(
        "\u274C [PERMISSIONS] Permission verification failed:",
        error
      );
      elizaLogger4.error(
        "Please ensure the following scopes are added to your Slack app:"
      );
      elizaLogger4.error("- app_mentions:read     (for mentions)");
      elizaLogger4.error("- channels:history      (for public channels)");
      elizaLogger4.error("- channels:read         (for channel info)");
      elizaLogger4.error("- chat:write            (for sending messages)");
      elizaLogger4.error("- groups:history        (for private channels)");
      elizaLogger4.error(
        "- groups:read           (for private channel info)"
      );
      elizaLogger4.error("- im:history            (for DMs)");
      elizaLogger4.error("- im:read               (for DM info)");
      elizaLogger4.error("- im:write              (for sending DMs)");
      elizaLogger4.error("- mpim:history          (for group DMs)");
      elizaLogger4.error("- mpim:read             (for group DM info)");
      elizaLogger4.error("- users:read            (for user info)");
      throw new Error("Permission verification failed");
    }
  }
  async start() {
    var _a, _b, _c, _d, _e, _f;
    try {
      elizaLogger4.log("Starting Slack client...");
      const config = await validateSlackConfig(this.runtime);
      const slackService = new SlackService();
      await slackService.initialize(this.runtime);
      await this.runtime.registerService(slackService);
      const auth = await this.client.auth.test();
      if (!auth.ok) throw new Error("Failed to authenticate with Slack");
      this.botUserId = auth.user_id;
      elizaLogger4.debug("\u{1F916} [INIT] Bot info:", {
        user_id: auth.user_id,
        bot_id: auth.bot_id,
        team_id: auth.team_id,
        user: auth.user,
        team: auth.team
      });
      try {
        const botInfo = await this.client.users.info({
          user: this.botUserId
        });
        elizaLogger4.debug("\u{1F464} [BOT] Bot user details:", {
          name: (_a = botInfo.user) == null ? void 0 : _a.name,
          real_name: (_b = botInfo.user) == null ? void 0 : _b.real_name,
          is_bot: (_c = botInfo.user) == null ? void 0 : _c.is_bot,
          is_app_user: (_d = botInfo.user) == null ? void 0 : _d.is_app_user,
          status: (_f = (_e = botInfo.user) == null ? void 0 : _e.profile) == null ? void 0 : _f.status_text
        });
      } catch (error) {
        elizaLogger4.error(
          "\u274C [BOT] Failed to verify bot details:",
          error
        );
      }
      await this.verifyPermissions();
      this.messageManager = new MessageManager(
        this.client,
        this.runtime,
        this.botUserId
      );
      this.runtime.registerAction(chat_with_attachments_default);
      this.runtime.registerAction(summarize_conversation_default);
      this.runtime.providers.push(channelStateProvider);
      this.server.use((req, res, next) => {
        elizaLogger4.debug("\u{1F310} [HTTP] Incoming request:", {
          method: req.method,
          path: req.path,
          headers: req.headers,
          body: req.body,
          query: req.query,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        next();
      });
      this.server.post(
        "/slack/events",
        async (req, res) => {
          var _a2, _b2, _c2, _d2, _e2, _f2;
          try {
            elizaLogger4.debug(
              "\u{1F4E5} [REQUEST] Incoming Slack event:",
              {
                type: (_a2 = req.body) == null ? void 0 : _a2.type,
                event: (_c2 = (_b2 = req.body) == null ? void 0 : _b2.event) == null ? void 0 : _c2.type,
                challenge: (_d2 = req.body) == null ? void 0 : _d2.challenge,
                raw: JSON.stringify(req.body, null, 2)
              }
            );
            if (((_e2 = req.body) == null ? void 0 : _e2.type) === "url_verification") {
              elizaLogger4.debug(
                "\u{1F511} [VERIFICATION] Challenge received:",
                req.body.challenge
              );
              return res.send(req.body.challenge);
            }
            if ((_f2 = req.body) == null ? void 0 : _f2.event) {
              elizaLogger4.debug("\u{1F3AF} [EVENT] Processing event:", {
                type: req.body.event.type,
                user: req.body.event.user,
                text: req.body.event.text,
                channel: req.body.event.channel,
                ts: req.body.event.ts
              });
              await this.handleEvent(req.body.event);
            } else {
              elizaLogger4.warn(
                "\u26A0\uFE0F [EVENT] Received request without event data"
              );
            }
            res.status(200).send();
          } catch (error) {
            elizaLogger4.error(
              "\u274C [ERROR] Error processing request:",
              error
            );
            res.status(500).json({
              error: "Internal server error"
            });
          }
        }
      );
      this.server.post(
        "/slack/interactions",
        async (req, res) => {
          var _a2, _b2, _c2;
          try {
            elizaLogger4.debug(
              "\u{1F504} [INTERACTION] Incoming interaction:",
              {
                type: (_a2 = req.body) == null ? void 0 : _a2.type,
                action: (_b2 = req.body) == null ? void 0 : _b2.action,
                callback_id: (_c2 = req.body) == null ? void 0 : _c2.callback_id,
                raw: JSON.stringify(req.body, null, 2)
              }
            );
            res.status(200).send();
          } catch (error) {
            elizaLogger4.error(
              "\u274C [ERROR] Error processing interaction:",
              error
            );
            res.status(500).json({
              error: "Internal server error"
            });
          }
        }
      );
      const port = config.SLACK_SERVER_PORT;
      this.server.listen(port, () => {
        elizaLogger4.success(
          `\u{1F680} [SERVER] Slack event server is running on port ${port}`
        );
        elizaLogger4.success(
          `\u2705 [INIT] Slack client successfully started for character ${this.character.name}`
        );
        elizaLogger4.success(
          `\u{1F916} [READY] Bot user: @${auth.user} (${this.botUserId})`
        );
        elizaLogger4.success(
          `\u{1F4E1} [EVENTS] Listening for events at: /slack/events`
        );
        elizaLogger4.success(
          `\u{1F4A1} [INTERACTIONS] Listening for interactions at: /slack/interactions`
        );
        elizaLogger4.success(`\u{1F4A1} [HELP] To interact with the bot:`);
        elizaLogger4.success(
          `   1. Direct message: Find @${auth.user} in DMs`
        );
        elizaLogger4.success(
          `   2. Channel: Mention @${auth.user} in any channel`
        );
      });
    } catch (error) {
      elizaLogger4.error("\u274C [INIT] Failed to start Slack client:", error);
      throw error;
    }
  }
  async stop() {
    elizaLogger4.log("Stopping Slack client...");
    if (this.server) {
      await new Promise((resolve) => {
        this.server.listen().close(() => {
          elizaLogger4.log("Server stopped");
          resolve();
        });
      });
    }
  }
};

// src/index.ts
var SlackClientInterface = {
  start: async (runtime) => {
    const client = new SlackClient(runtime);
    await client.start();
    return client;
  },
  stop: async (_runtime) => {
    console.warn("Slack client stopping...");
  }
};
var index_default = SlackClientInterface;
export {
  SlackClientInterface,
  index_default as default
};
//# sourceMappingURL=index.js.map