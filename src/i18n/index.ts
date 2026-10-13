import { en, type MessageKey } from "./en";

export type { MessageKey };
export type Messages = Partial<Record<MessageKey, string>>;

// To add a language, create ./<lang>.ts exporting Messages and list it here,
// keyed by language ("de") or full locale ("pt-br").
const languages: Record<string, Messages> = {};

let messages: Messages | null = null;

function resolve(): Messages {
	const locale = (window.Spicetify?.Locale?.getLocale() || navigator.language || "en").toLowerCase().replace("_", "-");
	return languages[locale] ?? languages[locale.split("-")[0]] ?? {};
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
	messages ??= resolve();
	const text = messages[key] ?? en[key];
	if (!vars) return text;
	return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}
