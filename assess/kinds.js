// Assessment activity types, shared by the facilitator console (assess/) and participants' phones (room/).
// Question data lives in activity.data.steps; the answer keys (correct, items order, pairs, region) never reach phones until "Reveal".
window.ASSESS = (() => {
  const KINDS = {
    poll:     { ic: "📊", name: "Live poll",        band: "pulse",   line: "Ask the room. Bars grow as the votes come in.", opts: true, sec: 0 },
    finger:   { ic: "✋", name: "Finger vote",      band: "pulse",   line: "The room raises 1 to 5 fingers and the webcam counts the hands. No phones.", opts: true, maxOpts: 5, sec: 0 },
    words:    { ic: "☁️", name: "Word cloud",       band: "pulse",   line: "Short answers float up and grow as more people say the same thing.", sec: 0 },
    scale:    { ic: "🎚️", name: "Confidence check", band: "pulse",   line: "A 0 to 10 slider. The room average shows as a gauge.", sec: 0 },
    quiz:     { ic: "❓", name: "Quiz",             band: "check",   line: "Timed multiple choice. Faster right answers score more, with a portrait leaderboard.", opts: true, scored: true, sec: 20 },
    buzz:     { ic: "⚡", name: "First to catch",   band: "check",   line: "The question flies onto every phone. The first correct answer wins the round.", opts: true, scored: true, sec: 0 },
    order:    { ic: "🔢", name: "Order it",         band: "check",   line: "Put the steps of a process in the right order.", scored: true, sec: 60 },
    match:    { ic: "🧩", name: "Match it",         band: "check",   line: "Pair each term with its meaning.", scored: true, sec: 60 },
    spot:     { ic: "🔍", name: "Spot the error",   band: "check",   line: "Show a slide or document with a planted mistake. Participants tap where it is.", scored: true, sec: 45 },
    battle:   { ic: "⚔️", name: "Group battle",     band: "teams",   line: "Group A against Group B. Every right answer pulls the tug-of-war bar.", opts: true, scored: true, sec: 20, teams: true },
    case:     { ic: "📂", name: "Case study race",  band: "teams",   line: "Each group answers a case. AI reviews the answers and gives quick feedback.", sec: 300, teams: true, text: true },
    wheel:    { ic: "🎡", name: "Spin to answer",   band: "teams",   line: "The wheel picks who answers aloud.", link: true },
    test:     { ic: "📈", name: "Pre & post test",  band: "reflect", line: "The same questions at the start and the end. Results show each person's learning gain.", opts: true, scored: true, sec: 30 },
    exit:     { ic: "🎟️", name: "Exit ticket",      band: "reflect", line: "“One thing I'll apply at my desk.” Collected per person.", sec: 0, text: true },
    feedback: { ic: "⭐", name: "Session feedback", band: "reflect", line: "Stars and a comment. Participants are also asked at tap-out.", sec: 0 }
  };
  const BANDS = [["pulse", "Quick pulse"], ["check", "Knowledge check"], ["teams", "Teams"], ["reflect", "Reflect"]];
  const LETTERS = "ABCDEF";
  const COLORS = ["#e8b44a", "#3fb98a", "#5aa9e6", "#f2786f", "#b48ef0", "#f0a35e"];

  function blankStep(kind) {
    const k = KINDS[kind] || {};
    if (kind === "finger") return { q: "", options: ["Yes", "No", "Not sure"] };
    if (k.opts) return k.scored ? { q: "", options: ["", "", "", ""], correct: 0 } : { q: "", options: ["", "", ""] };
    if (kind === "words") return { q: "", max: 1 };
    if (kind === "scale") return { q: "How confident are you to use this at work?", lo: "Not at all", hi: "Very confident" };
    if (kind === "order") return { q: "Put these in the right order", items: [] };
    if (kind === "match") return { q: "Match each term to its meaning", pairs: [] };
    if (kind === "spot") return { q: "Tap the error", image: "", aspect: 1.5, region: null };
    if (kind === "case") return { q: "What should the officer do, and why?", text: "" };
    if (kind === "exit") return { q: "One thing I'll apply at my desk next week" };
    if (kind === "feedback") return { q: "How useful was this session?" };
    return { q: "" };
  }

  // Short instructions for each step's answer format, used in the AI prompt.
  const SCHEMA = {
    poll: '{"q":"question","options":["2 to 5 short options"]}',
    finger: '{"q":"question","options":["2 to 5 short options; option 1 = one finger"]}',
    words: '{"q":"question that invites a one or two word answer","max":1}',
    scale: '{"q":"self-rating question","lo":"label for 0","hi":"label for 10"}',
    quiz: '{"q":"question","options":["4 options"],"correct":0-based index of the right option}',
    buzz: '{"q":"short question","options":["4 options"],"correct":0-based index}',
    battle: '{"q":"question","options":["4 options"],"correct":0-based index}',
    test: '{"q":"question","options":["4 options"],"correct":0-based index}',
    order: '{"q":"instruction","items":["3 to 7 steps in the CORRECT order"]}',
    match: '{"q":"instruction","pairs":[{"l":"term","r":"meaning"}, 3 to 6 pairs]}',
    case: '{"q":"the task to answer","text":"a realistic 80-150 word case scenario from Lagos State public service work"}',
    exit: '{"q":"reflection prompt"}',
    feedback: '{"q":"feedback question"}'
  };

  return { KINDS, BANDS, LETTERS, COLORS, blankStep, SCHEMA };
})();
