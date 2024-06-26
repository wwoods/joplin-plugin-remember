# joplin-plugin-remember

## Building

Must build with `NODE_OPTIONS=--openssl-legacy-provider` on newer node versions,
until Joplin updates its webpack version.

## Usage

Something like:

```
  ```remember
  Some text to remember
  ```
```

Or

```
  ```remember
  q: What was the answer?
  Some answer.
  q: Multiple questions are OK?
  Yes they are.
  ```
```

Will associate the note's title with the specified content.

```
  ```remember
  Some text to remember
  # Context
  Content to remember it by
  ```
```

Will instead provide `Content to remember it by` as the triggering key.

```
\`\`\`remember
Blah
# Options
reverse: true
\`\`\`
```

Will half of the time use the content to be remembered as the memory key,
asking that the user recall the context.

The notebook `Remember-DB-Review` will be used to present the user with daily
(or however often) quizzes. These should be viewed in non-markdown mode -- the
user can click through, adding additional context, and then check their work.
They then check a box answering a 0-5 scale on how comfortable they were with
the level of recall. Any unanswered questions are totally fine, as the system
will simply add them to the next survey (as though the user hadn't seen them).

Each note may have zero or more `remember` blocks. Each one is treated as a
unique factoid, and receives its own weighting for spaced repetition. The first
time that `joplin-plugin-remember` scans a `remember` block, it will append some
metadata to the opening statement which acts as a unique ID, such that other
blocks may be added / removed without messing up the tracking of factoids.

## Improper Usage

The system is fine with deleting remember blocks. If you're in the text editor taking notes and don't want the overhead of splitting notes / dealing with Joplin's UI:

```
\`\`\`remember
Put above in its own note! Or add to my calendar
\`\`\`
```

# Recall system

This plugin uses spaced repitition, similar to Anki or other.

The current formula is based on SuperMemo-2 and uses a default efactor of 1.3.
The exact formula for the number of days between reminders is:

$$
  efactor_t &= max\left(1.3, efactor_{t-1} + (0.1 - (5 - score) * (0.8 + (5 - score) * 0.02))\right) \\
  days_t &= 1\text{ if }score \in \{0, 1, 2\}\text{ else }max\left(6, days_{t-1} * efactor_t\right)
$$

As a table, for convenience, here's score to efactor changes:

| Score | Efactor Delta |
| ----- | ------------- |
|     0 | -0.80         |
|     1 | -0.54         |
|     2 | -0.32         |
|     3 | -0.14         |
|     4 |  0.00         |
|     5 |  0.10         |

# Acknowledgements

Thanks to https://github.com/martinkorelic/joplin-plugin-spoiler-cards for the details business.

# Changelog

* 2024-06-03 1.0.8. Stab at fixing multi-quiz issue with multiple devices syncing. I think it's because the index takes awhile to update post-sync.

* 2024-05-30 1.0.7. Initial quiz generation only happens after first sync or 10 minutes, whichever happens first. Quiz generated even if no questions for the day. Error messages are stored in quiz rather than squelched. Quizzes get link to the Remember plugin's database for a given question. Quiz database pages store metadata about a question, allowing users to disable that question by modifying the JSON.

* 2024-04-25 1.0.6. Deleted old records when there were multiple. This error likely resulted from sync-related issues, and blocked the generation of quizzes, which prevented the plugin from functioning.

# Joplin Plugin

This is a template to create a new Joplin plugin.

The main two files you will want to look at are:

- `/src/index.ts`, which contains the entry point for the plugin source code.
- `/src/manifest.json`, which is the plugin manifest. It contains information such as the plugin a name, version, etc.

## Updating plugin version

Change both `package.json` and `src/manifest.json`. Run `npm run dist`, then distribute `publish/io.github.wwoods.JoplinPluginRemember.jpl`.

## Building the plugin

The plugin is built using Webpack, which creates the compiled code in `/dist`. A JPL archive will also be created at the root, which can use to distribute the plugin.

To build the plugin, simply run `npm run dist`.

The project is setup to use TypeScript, although you can change the configuration to use plain JavaScript.

## Updating the plugin framework

To update the plugin framework, run `npm run update`.

In general this command tries to do the right thing - in particular it's going to merge the changes in package.json and .gitignore instead of overwriting. It will also leave "/src" as well as README.md untouched.

The file that may cause problem is "webpack.config.js" because it's going to be overwritten. For that reason, if you want to change it, consider creating a separate JavaScript file and include it in webpack.config.js. That way, when you update, you only have to restore the line that include your file.
