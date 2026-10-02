import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Alert,
  AppShell,
  Button,
  Card,
  Icon,
  Spinner,
  TextField,
} from "@fintech-network/design-system";
import type { AssistantAnswerDto, AssistantCapabilitiesDto } from "@fintech-network/shared-types";
import { useAsync } from "@fintech-network/app-kit";
import { api, ApiError } from "../api/client";
import { NAV_ITEMS } from "../nav";

// Ask: questions about your own money, answered from your own account.
//
// Two things this screen deliberately does not do. It doesn't pretend to
// be a person — no typing dots, no avatar, no chat-app furniture — and it
// doesn't keep the conversation. The log lives in this component's state
// and goes when you leave, because the API doesn't store what you asked
// either (spec §26). Nothing here can move money: an answer's links go
// to the same screens as the rest of the app, where you do it yourself.

interface Turn {
  question: string;
  answer: AssistantAnswerDto | null;
  error: string | null;
}

function Answer({ answer }: { answer: AssistantAnswerDto }) {
  return (
    <div className="ds-ask__reply" data-testid="assistant-answer">
      {answer.answer}
      {answer.figures.length > 0 ? (
        <div className="ds-ask__figures" data-testid="assistant-figures">
          <span className="ds-muted ds-small">From your account:</span>
          {answer.figures.map((figure) => (
            <span key={figure.name} className="ds-ask__figure">
              {figure.display}
            </span>
          ))}
        </div>
      ) : null}
      {answer.suggestions.length > 0 ? (
        <div className="ds-ask__links">
          {answer.suggestions.map((suggestion) => (
            <Link key={suggestion.path} to={suggestion.path} className="ds-chip">
              {suggestion.label}
              <Icon name="chevron" size={16} aria-hidden="true" />
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Intro({ capabilities }: { capabilities: AssistantCapabilitiesDto }) {
  return (
    <Card>
      <div className="ds-stack">
        <div className="ds-row">
          <span className="ds-avatar ds-avatar--accent" aria-hidden="true">
            <Icon name="ask" size={22} />
          </span>
          <div>
            <div style={{ fontWeight: 650 }}>Ask about your money</div>
            <div className="ds-muted ds-small">
              Your balance, what you've spent, what's waiting for you.
            </div>
          </div>
        </div>
        {/* Said by the server, so what's promised here is exactly what the
            assistant is allowed to do. */}
        <div className="ds-muted ds-small">
          <strong>I can't:</strong> {capabilities.cannot.join(" · ")}
        </div>
      </div>
    </Card>
  );
}

export function AssistantScreen() {
  const capabilities = useAsync(async () => (await api.assistant()).assistant);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [asking, setAsking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const ask = async (asked: string) => {
    const text = asked.trim();
    if (text.length === 0 || asking) return;
    setAsking(true);
    setQuestion("");
    const index = turns.length;
    setTurns((previous) => [...previous, { question: text, answer: null, error: null }]);
    try {
      const { assistant } = await api.askAssistant(text);
      setTurns((previous) =>
        previous.map((turn, i) => (i === index ? { ...turn, answer: assistant } : turn))
      );
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : "I couldn't reach your account just now. Try again in a moment.";
      setTurns((previous) =>
        previous.map((turn, i) => (i === index ? { ...turn, error: message } : turn))
      );
    } finally {
      setAsking(false);
      inputRef.current?.focus();
    }
  };

  const examples = capabilities.data?.examples ?? [];

  return (
    <AppShell title="Ask" nav={NAV_ITEMS}>
      {capabilities.error ? (
        <Alert tone="danger" title="We couldn't reach the assistant">
          <Button variant="ghost" onClick={capabilities.reload}>
            Try again
          </Button>
        </Alert>
      ) : null}

      {capabilities.data ? <Intro capabilities={capabilities.data} /> : null}

      {turns.length === 0 && examples.length > 0 ? (
        <div className="ds-stack">
          <h2 className="ds-section-title">Try one of these</h2>
          <div className="ds-chips">
            {examples.map((example) => (
              <button
                key={example}
                type="button"
                className="ds-chip"
                disabled={asking}
                onClick={() => ask(example)}
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {turns.length > 0 ? (
        <div className="ds-ask__log">
          {turns.map((turn, index) => (
            <div className="ds-ask__turn" key={`${index}-${turn.question}`}>
              <div className="ds-ask__you">{turn.question}</div>
              {turn.answer ? (
                <Answer answer={turn.answer} />
              ) : turn.error ? (
                <div className="ds-ask__reply" role="alert">
                  {turn.error}
                </div>
              ) : (
                <div className="ds-ask__reply">
                  <Spinner label="Looking it up" />
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}

      <form
        className="ds-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(question);
        }}
      >
        <TextField
          ref={inputRef}
          label="Your question"
          value={question}
          maxLength={280}
          placeholder="What's my balance?"
          onChange={(event) => setQuestion(event.target.value)}
        />
        <Button type="submit" block disabled={asking || question.trim().length === 0}>
          {asking ? "Asking…" : "Ask"}
        </Button>
      </form>

      <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
        {capabilities.data?.disclaimer ??
          "Figures come from your account, not from the assistant."}
      </p>
    </AppShell>
  );
}
