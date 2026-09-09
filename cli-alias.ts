interface ChatSession {
    chatId: number;           // Telegram chat ID
    mode: "agent" | "clinecore";
    agent: AgentMode | null;  // Local Agent instance
    core: CoreMode | null;    // Local ClineCore instance
    projectId?: string;
}
const sessions = new Map<number, ChatSession>();