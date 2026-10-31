# How to add a skill

Drop a `.md` file in this folder. That is the whole process — the agent picks it
up on the next message, no restart and no code change.

```
soul/skills/my-skill.md
```

Optional front matter at the top of the file:

```markdown
---
name: Funding carry
when: funding is above 0.05% per 8h
enabled: true
---

Write the knowledge here, in plain prose or bullets. Address it as yourself
("I do X when Y") — it is spliced into the agent's own SKILL section.
```

| Field | Meaning |
|---|---|
| `name` | Heading shown to the model. Defaults to the filename. |
| `when` | The trigger. Tells the model *when* this knowledge applies, so it is not read as always-on. Optional but recommended. |
| `enabled` | `false` parks the file without deleting it. Defaults to `true`. |

Files load in filename order, so prefix with numbers (`10-`, `20-`) if one skill
should be read before another.

## From Telegram, without touching the filesystem

```
/skills                                   list everything and its state
/skills add scalp-btc | I only scalp BTC between 12:00 and 20:00 UTC...
/skills show scalp-btc
/skills off scalp-btc                     park it
/skills on scalp-btc
/skills rm scalp-btc
/reload                                   re-read soul/ after editing by hand
```

## What makes a good skill

Write **judgement**, not facts the agent can look up with a tool. It already has
33 tools for prices, funding, balances and history.

Good: *"After two consecutive losses on the same symbol I halve size until a
winner, regardless of what the scanner says."*

Bad: *"BTC is trading around 86,000."* — stale the moment you write it.

Keep each file to one idea. Five focused files beat one long one, because the
`when:` triggers let the model reach for the right one.

Note: this README is skipped — it has no body outside the headings the loader
needs, and you can delete it safely.
