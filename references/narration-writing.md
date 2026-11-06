# Writing narration that sounds like a person

A clean script can still be bad. In the case behind this page, a rewrite brought the lint to zero and the author still called it rubbish: every line was correct, nothing was wrong with the sentences, and it was a list of rules read aloud. Sentence-level fixes (the tables below, `script lint`, `script review --focus voice`) remove the most obvious tells. They cannot supply what was missing: someone who knows the subject saying what matters and why.

So the order is:

1. **Talk to the author before writing.** Ask, in conversation, what they want people to remember, what surprises people or gets misunderstood, what they think of it, what the audience will ask, what to leave out. A few questions, plainly, not a form. If they have already said it in this conversation, use their words and ask only about the gaps. Keep their answers verbatim at the top of SCRIPT.md; they are the material. Documents say what something is; only the author knows what matters.
2. **Write from those answers, not from the documents.** The documents are for checking facts. Most of their content does not belong in the film: cut until each part says something the listener did not know and gives the reason behind it. A part that only adds another fact to a pile is merged or cut.
3. **Say why.** Every rule that survives comes with its purpose or its consequence (「连停奖励的狠处在后半句：断一天就从头算。用户为了不断，每天都会回来把车停好。」). Rules without reasons are what make a walkthrough sound like a manual.
4. **Hear it before production.** Voice two or three key shots (`motion-use voiceover audition`) or read it aloud as the author would to these people, and rewrite whatever sounds read rather than said.
5. **Clean up last.** Then run `script lint` and the review passes below. Their findings are evidence, not a target: a script that scores zero is not done because it scores zero.

No framework or fill-in structure replaces step 1. A script built from a template sounds like the template.

## How a script turns into a machine voice

The usual cause is not a word choice. It is the process:

1. **The script is a translation of the source document.** Shots follow the document's sections (§3 → §4 → §5…), each shot restates one section, and the film inherits the document's skeleton.
2. **A fact review adds qualifiers.** "some cards", "at most five times a day", "provided the account has no violations": each one is correct and each one makes the line read like a clause. Accuracy and spoken voice are separate reviews; qualifiers go on screen first.
3. **One shot = one narration paragraph = one screen line.** Every paragraph grows the same shape: topic sentence, rule details, closing sentence.
4. **The voice flattens it further.** A TTS read at an even rate gives every clause the same weight; a flat script has nothing for it to stress.

Listeners hear it within the first second. A typical opening line:

> 你每把车停进白线框，三十秒后，账户里就多十个积分。

It is a rule (every… after 30 s… then…), it gives a parameter before the viewer knows what they are looking at, and its clauses have the same length. Openings like this often also coin a phrase to avoid a term the team already uses. A person pointing at the screen says:

> 你看这辆车，轮子正好压在白线里面。拍一张，账户马上多出十个积分。

The 30 s goes on screen, or later in the shot that explains the rule.

## Sentence-level tells

Know who is speaking and to whom: an internal walkthrough is a colleague talking to colleagues ("我们 / 咱们", "we"), a product film may speak to a user. Keep "you" for one person. Order the film by what the listener needs first, not by the source document's chapters.

Line by line:

| Rule | Instead of | Write |
|---|---|---|
| The first line is said while pointing at the picture: one thing, one thing happening | a rule, a number, a coined term | 「你看这辆车，轮子正好压在白线里面。」 |
| Name a thing once, without a reveal | 「……，这叫有效停车。」「……，这叫连停奖励。」 again and again | the term the team uses, said in passing: 「连着七天都停对，再送五十分。」 |
| Stop when the information stops | 「所以停得越规范，骑得越便宜。」 at the end of shot after shot | let the picture land it, or say the consequence as a fact once |
| Two items in speech; the rest on screen | 「推荐区、普通区、禁停区」「同一辆车……；同一个账号……；照片重复……」 | two in speech, the full list as screen text (`【屏幕字：…】` in review rewrites) |
| One or two numbers per spoken line | three quantities in one breath | the decisive number spoken; the others on screen |
| Spoken register | 一律、前提是、细则、进行、予以、相应、此外 / utilize, furthermore, in order to | the words you would use across a table |
| Vary the shape | every shot opening with 「这是…」 or a topic sentence | open some shots on an action, some on a question, some on the picture |
| Leave room for short sentences | every sentence 12–20 characters | 「你看。」「就这样。」 — a few short lines give the voice somewhere to breathe |
| One judgement where the speaker has one | no opinion anywhere | 「防刷分这块最容易被问。」 |

### Over-correcting is a second fingerprint

A script rewritten only to avoid the patterns above tends to grow new ones. In the same case, the first rewrite cleared every rule in the table and a blind reviewer still heard a template; a further rewrite cleared those too and was still rubbish, because steps 1–3 had never happened:

| Pattern | Example | Instead |
|---|---|---|
| Announcing the outline before the content | 「拿积分有两个条件：」「月底多了一件事。」「第一样是积分」「第二样是券」「第三样是会员」 | start with the first condition or the first thing; let the listener count |
| Matched pairs | 「一样的车，一样的线」「停对一次，多十分；停满七天，多五十分」 | the rule once, in one plain clause: 「车轮压在白线里才算停对。」 |
| Filler that sounds spoken | 「积分这块，记住白线就行。」 then four rules | name the thing; do not promise "just remember" before a list |
| Chopped sentences | every line cut to 4–8 characters so it "sounds like speech" | short sentences where the speaker pauses, full sentences where a relation needs explaining |
| A conclusion stronger than the rule | 「停错就没积分了」 when it only halves them, 「全看自觉」 when photos are checked | say what the rule does: 「停错了积分减半」 |
| Switching who "you" is | 「用户要做的是…」 then 「你停好拍一张」 then 「我们出接口」 | one name for the player throughout; "we" only for the team |

The test that catches both layers: read it aloud as the stated speaker to the stated audience. If a colleague would ask "why are you talking like that?", rewrite the line.

Do not invent facts to sound specific. A missing number stays missing; a vivid example must be true (motion-use's script review keeps a list of new-fact candidates for this reason).

## The two review passes

1. **Facts.** Every number, rule and claim against the source. Record qualifiers the facts need; put them on screen or in DIRECTOR.md first.
2. **Voice.** Only how it is said. A pass that smooths the grammar but keeps the structure (the opening still a rule, every shot still the same shape) has not been done.

```bash
motion-use script lint my-film                       # countable fingerprints, with evidence
motion-use script review my-film --reviewer codex --transport command \
  --command '["codex","exec","--skip-git-repo-check","-s","read-only","-"]' --focus voice --out my-film/reviews/02-voice.md
motion-use script review my-film --reviewer gemini --focus facts --out my-film/reviews/03-facts.md
```

`--focus both` (the default) runs both passes in one request and tags each issue 【事实】 or 【口语】.

## What the lint counts

| Rule | Fires when |
|---|---|
| `opening-quantity` | the first sentence of the first narrated shot has a number or unit in its opening characters |
| `opening-rule` | the first sentence is a rule (每…就, 只要…就, 一旦 / every time, whenever) |
| `name-reveal` | 「这叫 / 叫做 / 这就是所谓」 ("this is called", "known as") appears twice or more |
| `moral-tail` | two or more shots end on 「所以 / 这就是 / 总之」 ("so", "that's why", "in short") |
| `definition-open` | two or more shots (or the first shot) open with 「这是…」 ("this is…") |
| `spoken-list` | four or more spoken lists of three short items in one script, or one list of five or more |
| `semicolon-chain` | two or more semicolons in one shot's narration |
| `written-register` | a written-register word from the table above |
| `frame-open` | two or more shots open by announcing a count or a numbered item (「有两个条件」「第一样是」 / "there are three", "first,") |
| `filler` | two or more fillers that sound spoken but point at nothing (「这块」「记住…就行」「说白了」 / "basically", "just remember") |
| `symmetric-pair` | two or more matched clause pairs (same opening, same length) |
| `audience-drift` | the script says "you" twice or more and also names the role (玩家 / 用户 / player / user) twice or more |
| `script-drift` | the SCRIPT.md shot table and film.json say different things for a shot, or a shot is spoken in one and not the other. The voiceover reads film.json, so a reviewed SCRIPT.md that never reached film.json is not what ships. `script lint` lists each shot; `validate`, `render` and `voiceover` print one summary warning |

Thresholds come from a shipped internal explainer that reviewers recognised as machine-written within the first second (19 findings there; it stays private) and the synthetic pair in `test/fixtures/`: a script in the same shape (`narration-ai.json`, 16 findings), a first rewrite that over-corrected (10 findings there: frame-open, filler, symmetric-pair; also private) and the same fictional facts said by a colleague (`narration-human.json`, none). They are warnings: keep a line on purpose and say why in DIRECTOR.md. Rules exist for Chinese and English; other languages are skipped.

## Second layer: stop-slop

`script lint` counts what a summarised document leaves behind. [stop-slop](https://github.com/leeguooooo/stop-slop-zh) is a separate Chinese AI-writing detector with densities measured on human and model text, and it counts what this lint does not: semicolons spread one per shot (the lint's `semicolon-chain` needs two in one shot), adjacent sentences built the same way, 「不是…而是…」, rated suspense (「最绕的是」), a colon introducing the point, translationese.

When `stop-slop` 1.2.0 or later is on PATH (or named by `MOTION_USE_STOP_SLOP`), `script lint` runs its spoken mode (`stop-slop detect --shots - --json`, one entry per shot) on every Chinese script it reads, SCRIPT.md and film.json alike. Flagged A (wording), B (structure) and F (punctuation) items become findings named `stop-slop/<id>`, such as `stop-slop/F2` or `stop-slop/R13b`, with its advice and the human reference density. `--json` keeps its raw items under `stop_slop`. Without it the lint says so, prints the install line and carries on:

```sh
curl -fsSL https://raw.githubusercontent.com/leeguooooo/stop-slop-zh/main/install.sh | sh
```

Its X (change with care) and H (human judgement) items are never reported as problems. Read them as a guard rail against over-correcting (above): a question in the narration, a metaphor, items joined inside one sentence, a sentence length kept for rhythm. Leave those alone unless the line is wrong for another reason (stop-slop-zh `SKILL.md`, section 8). `stop-slop compare before.txt after.txt` shows whether a rewrite only moved the fingerprints around.

`script review` uses it too. Its findings join the lint evidence the reviewer sees, and with stop-slop 1.3.0 or later the voice pass (`--focus voice` or `both`) also gets the joins between neighbouring shots from `stop-slop candidates --shots -`: the end of one shot and the start of the next. The reviewer is asked whether each shot picks up the one before it or restarts the subject, using the criteria in stop-slop-zh `references/semantic.md`, section 2. The evidence file records the stop-slop version and how many joins were sent. To look at them yourself:

```sh
node -e 'const f=require("./film.json");console.log(JSON.stringify(f.shots.map(s=>({id:s.id,text:s.narration?.zh?.say??s.narration?.zh??s.narration})).filter(x=>typeof x.text==="string")))' \
  | stop-slop candidates --shots -
```

Sources: two independent reviews of that film (Claude and Codex); the author's Chinese anti-slop checklist (程度副词、排比三件套、金句收尾、名词化); interview-first drafting ([Make AI interview you before it writes anything](https://mediacopilot.substack.com/p/make-ai-interview-you-before-it-writes)); Poynter's mouth edit (read it aloud and revise what sounds read); Wikipedia's [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) for the sentence-level layer; [Verbalized Sampling](https://arxiv.org/abs/2510.01171) for asking a reviewer for several openings ranked by how typical they are.
