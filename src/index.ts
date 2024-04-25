import joplin from 'api';

//TODO wait for synchronization before running first check. Consider this a safety
//feature...

import {ContentScriptType, SettingItemType} from 'api/types';

const pluginName = 'io.github.wwoods.JoplinPluginReminder';

class RememberBlockMatch {
  id: string|null = null;
  constructor(public text: string, public start: number, public stop: number) {
    const name = /^```remember (\S+)/.exec(text);
    if (name === null) {
      this.id = null;
    }
    else {
      this.id = name[1];
    }
  }
}
function* findRememberBlocks(body: string) {
  const regex = /(^|\n)(```remember( |\n|$).*?(^|\n)```)/gms;
  let m;
  while ((m = regex.exec(body)) !== null) {
    yield new RememberBlockMatch(m[2], m.index + m[1].length, m.index + m[0].length);
  }
}

/** Looks like we'll need a CodeMirror plugin (https://github.com/CalebJohn/joplin-math-mode/blob/main/src/mathMode.ts)
 * as well as scanning note bodies for (newline + ```remember... newline ```).
 * */


/** Run some tests */
async function runTests() {
  // Add a note with known content and two remember blocks
  const notebook = await joplin.data.post(['folders'], null, {
    title: 'Remember-Tests',
  });
  
  const note1Content = `Hey there\n\`\`\`remember\nThis is a thing\n\`\`\`
More content
see this?

\`\`\`remember\nBeep boop\n\`\`\`

Again`;
  const note1ContentExpected = `Hey there\n\`\`\`remember 1\nThis is a thing\n\`\`\`
More content
see this?

\`\`\`remember 2\nBeep boop\n\`\`\`

Again`;
  const note1 = await joplin.data.post(['notes'], null, {
    title: 'note1',
    body: note1Content,
    parent_id: notebook.id,
  });

  const note2Content = `\`\`\`remember\nThis was at the top\n\`\`\`\nand\n\`\`\`remember\nthis is at the bottom\n\`\`\``;
  const note2ContentExpected = `\`\`\`remember 1\nThis was at the top\n\`\`\`\nand\n\`\`\`remember 2\nthis is at the bottom\n\`\`\``;
  const note2 = await joplin.data.post(['notes'], null, {
    title: 'note2',
    body: note2Content,
    parent_id: notebook.id,
  });

  // Joplin updates indices after ~10 sec
  await new Promise((resolve) => setTimeout(resolve, 15000));

  try {
    await forceScan();

    console.log('Test results');
    const n1 = await joplin.data.get(['notes', note1.id], {fields: 'body'});
    const n2 = await joplin.data.get(['notes', note2.id], {fields: 'body'});
    const compare = (header, body, expected) => {
      if (body === expected) {
        console.log(`${header}: OK`);
        return;
      }
      console.log(`${header}: Bad`);
      console.log(`=== Expected\n${expected}\n\n=== Body\n${body}`);
    };
    compare('Note one', n1.body, note1ContentExpected);
    compare('Note two', n2.body, note2ContentExpected);
  }
  finally {
    // Cleanup
    await joplin.data.delete(['notes', note1.id]);
    await joplin.data.delete(['notes', note2.id]);
    await joplin.data.delete(['folders', notebook.id]);
  }
}


let forceScan: {(): Promise<void>};

joplin.plugins.register({
	onStart: async function() {
		console.info('joplin-plugin-remember plugin started!');

    let scanUnderway: boolean = false;
    forceScan = async () => {
      while (scanUnderway) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      scanUnderway = true;
      try {
        await db.scan(true);
      }
      finally {
        scanUnderway = false;
      }
    };
    (window as any).rememberPluginForceScan = forceScan;
    console.info('window.rememberPluginForceScan() added!');
    (window as any).rememberPluginRunTests = runTests;
    console.info('window.rememberPluginRunTests() added!');

    await joplin.settings.registerSection(pluginName, {
      label: 'Remember',
      iconName: 'fas fa-heartbeat',
    });

    await joplin.settings.registerSettings({
      'regenerate': {
        section: pluginName,
        public: true,
        type: SettingItemType.Bool,
        label: 'Regenerate for today (toggle to activate; can also run `rememberPluginForceScan()` from console)',
        value: false,
        advanced: true,
      },
    });

    joplin.settings.onChange(async (event: any) => {
      if (event.keys.indexOf('regenerate') === -1) return;
      await forceScan();
    });

    await joplin.contentScripts.register(
        ContentScriptType.MarkdownItPlugin,
        'joplin-plugin-remember-remember',
        './block-remember.js',
    );
    await joplin.contentScripts.register(
        ContentScriptType.MarkdownItPlugin,
        'joplin-plugin-remember-remember-review',
        './block-remember-review.js',
    );

    const db = new Db();
    await db.init();

    while (true) {
      if (!scanUnderway) {
        scanUnderway = true;
        try {
          await db.scan();
        }
        catch (e) {
          console.error(e);
        }
        finally {
          scanUnderway = false;
        }
      }

      // Only do so once per minute or so
      await new Promise((resolve) => setTimeout(resolve, 60 * 1000));
    }
	},
});


class Db {
  static DB_NAME = 'Remember-DB';
  static DB_LOG_NAME = 'Log';
  static DB_REVIEW_NAME = 'Review';
  static SOURCE_URL_PREFIX = 'joplin-remember/';

  databaseFolder: null|string = null;
  logFolder: null|string = null;
  reviewFolder: null|string = null;

  get databaseFolderName() {
    return `${Db.DB_NAME}`;
  }

  get logFolderName() {
    return `${Db.DB_NAME}-${Db.DB_LOG_NAME}`;
  }

  get reviewFolderName() {
    return `${Db.DB_NAME}-${Db.DB_REVIEW_NAME}`;
  }

  /** Gets called both on startup AND if the metadata note isn't found.
   */
  async init() {
    // Find database folders
    this.databaseFolder = await this._ensureFolder(this.databaseFolderName, '');
    this.reviewFolder = await this._ensureFolder(this.reviewFolderName,
        this.databaseFolder);
    this.logFolder = await this._ensureFolder(this.logFolderName,
        this.databaseFolder);
  }


  async _ensureFolder(name: string, parent_id: string) {
    for await (const f of paginatedData(['folders'])) {
      if (f.parent_id !== parent_id) continue;
      if (f.title === name) {
        return f.id;
      }
    }

    console.log(`Could not find ${name}; creating`);
    const response = await joplin.data.post(['folders'], null, {
      title: name,
      parent_id: parent_id,
    });
    return response.id;
  }


  /** Scan the database for anything which was updated before today (that is,
   * yesterday). This is important because we assume the user may be editing
   * or re-editing anything from today.
   *
   * Arguments:
   *   force: true to re-process current day, regardless of other circumstances.
   * */
  async scan(force: boolean = false) {
    let metadata = await this.specificNote('metadata');
    if (metadata === null) {
      // If folders have been deleted, we must recreate them.
      await this.init();
      metadata = await joplin.data.post(['notes'], null, {
        title: 'Metadata',
        parent_id: this.databaseFolder,
        body: new PropertyGrid().toString(),
        source_url: this.specificNoteValue('metadata'),
      });
    }

    const pg = new PropertyGrid();
    pg.load(metadata.body);

    if (pg.properties.reviews_completed === undefined) pg.properties.reviews_completed = 0;

    const now = new Date();
    let newLimit = dateToFormat(now);

    let lastUpdated = pg.properties.last_updated;
    console.log(`Considering update... ${newLimit} / ${lastUpdated}`);
    if (newLimit === lastUpdated && !force) {
      // Up to date, nothing to do.
      return;
    }

    let loader;
    const loaderFields = ['id', 'title', 'body', 'parent_id', 'updated_time'];
    if (lastUpdated === undefined) {
      loader = paginatedData(['notes'], {fields: loaderFields});
    }
    else {
      loader = paginatedData(['search'], {
        query: `updated:${lastUpdated}`,  // To not look at current docs:  -updated:${newLimit}`,
        fields: loaderFields,
      });
    }
    for await (const n of loader) {
      // This note was updated... process.
      if (n.parent_id === this.reviewFolder) {
        if (!force && n.updated_time > Date.now() - 3600 * 1000) {
          // Modified within last hour and not forced -- delay evaluating this
          // review. In fact, abort this whole process since we don't want to
          // trigger a new review while the user is actively working on an
          // existing review.
          console.log(`Aborting update due to ${n.id} / ${n.title} being modified `
              + `only ${(n.updated_time - Date.now()) / 60000} minutes ago.`);
          return;
        }
        const newlyCompleted = await this._scan_updateReview(n);
        if (newlyCompleted) pg.properties.reviews_completed++;
        continue;
      }

      // See if it has any `remember` blocks,
      // and update the meta-collection if it does/not.
      if (findRememberBlocks(n.body).next().done) continue;

      const noteName = this.logNoteName(n.id);
      const wasTracked = await this.specificNote(noteName);
      if (wasTracked) {
        // Update tracked blocks.
        const logRecord = new LogRecord(wasTracked);
        await logRecord.loadBlocks(n);
        await logRecord.write();
      }
      else {
        // Create new log
        const logRecord = await LogRecord.create(this, n);
        await logRecord.loadBlocks(n);
        await logRecord.write();
      }
    }

    // Wait a second so that search is updated... actually, search seems to
    // update after 10 seconds...
    await new Promise((resolve) => setTimeout(resolve, 15000));

    // Now re-scan notes which have remember blocks attached, looking for
    // items to integrate into the reminder system. Then make new reminder note
    // for this day.
    console.log('Re-scanning and making new review note');
    const quizParts = [];
    for await (const note of paginatedData(['search'], {
        query: `notebook:${this.logFolderName}`,
        fields: ['id', 'title', 'body', 'parent_id']})) {
      quizParts.push(this._scan_getQuiz(note, newLimit,
            pg.properties.reviews_completed));
    }
    const quizParts2 = await Promise.all(quizParts);
    const quizFlat = [];
    for (const qp of quizParts2) {
      quizFlat.push.apply(quizFlat, qp);
    }
    arrayShuffle(quizFlat);

    // Build review note, post it
    const noteBody = []
    let qNumber = 1;
    for (const q of quizFlat) {
      noteBody.push(`# ${qNumber}\n\n${q}\n\n`);
      qNumber += 1;
    }

    if (qNumber !== 1) {
      // There's a new quiz
      const pgQuiz = new PropertyGrid();
      pgQuiz.properties.date = newLimit;
      pgQuiz.properties.reviewNumber = pg.properties.reviews_completed;
      noteBody.push(`# Data\n${pgQuiz.toString()}`);
      await joplin.data.post(['notes'], null, {
        title: `${newLimit} Review`,
        body: noteBody.join(''),
        parent_id: this.reviewFolder,
      });
    }

    pg.properties.last_updated = newLimit;
    await joplin.data.put(['notes', metadata.id], null, {
      body: pg.toString(),
    });
  }


  /** Given a log note, return a list of quizzes to be immediately appended to
   * a quiz. May be empty list.
   * */
  async _scan_getQuiz(logNote: any, date: string, reviewsCompleted: number) {
    const logRecord = new LogRecord(logNote);

    // Don't load the baseNote unless we have to actually generate a quiz.
    let baseNote = null;

    const r = []
    for (const block of logRecord.blocksTracked) {
      if (!block.needsQuiz(date, reviewsCompleted)) continue;
      if (baseNote === null) {
        try {
          baseNote = await joplin.data.get(['notes', logRecord.note_id],
              {fields: ['id', 'title', 'body', 'parent_id']});
        }
        catch (e) {
          // Just skip creating the quiz if the original note doesn't exist.
          // TODO clean up after note hasn't existed for X days
          if (e.message === 'Not Found') return r;
          throw e;
        }
      }
      // Note that this doesn't update the log record at all. That only happens
      // when a quiz is completed.
      const blockQuiz = block.makeQuiz(baseNote);
      if (blockQuiz !== undefined) {
        r.push(blockQuiz);
      }
    }

    return r;
  }


  /** Look at the given review note and append/update any information pertaining
   * to the questions contained within.
   *
   * Returns `true` if this is the first time the review was counted as
   * completed.
   * */
  async _scan_updateReview(reviewNote: any) {
    const reviewRecord = new ReviewRecord(reviewNote);
    if (reviewRecord.cleanupSections()) {
      if (reviewRecord.sections.length === 0) {
        // All questions were unanswered. Delete and move on.
        await joplin.data.delete(['notes', reviewNote.id]);
        return false;
      }
      await reviewRecord.write();
    }

    console.log(reviewRecord.sections);
    for (const sec of reviewRecord.sections) {
      if (sec.score === null) continue;

      const logNote = await this.specificNote(this.logNoteName(sec.note_id));
      if (logNote === null) {
        console.error(`No log for ${sec.note_id}?`);
        continue;
      }

      const logRecord = new LogRecord(logNote);
      logRecord.logScore(sec.block_id, reviewRecord.date,
          reviewRecord.reviewNumber, sec.score);
      await logRecord.write();
    }

    if (reviewRecord.properties.completed === undefined) {
      reviewRecord.properties.completed = true;
      reviewRecord.reviewNote.title += ' (counted)';
      await reviewRecord.write();
      return true;
    }

    return false;
  }


  /** Retrieves a note (with Joplin's internal ID) based on a deterministic ID.
   *
   * Returns `null` if it does not exist.
   *
   * This is achieved by hijacking the 'sourceurl' attribute of notes.
   * */
  async specificNote(id: string) {
    // NOTE -- as of 2021-04-19, deleting a notebook will keep deleted notes in
    // the search index! If we do not filter on both sourceurl and notebook, then
    // we cannot reset this plugin's data by simply deleting the notebook.
    const r = await joplin.data.get(['search'], {
      query: `sourceurl:${this.specificNoteValue(id)} notebook:${this.databaseFolderName}`,
      fields: ['id', 'title', 'body', 'source_url'],
    });
    if (r.items.length === 0) return null;
    if (r.items.length > 1) {
      // Often, this happens due to e.g. sync conflicts
      // The "right" thing to do is ambiguous. We could:
      // 1. Delete entries after the first. Might delete the wrong record.
      // 2. Keep all entries, and just return the first. Might cause confusing
      //    updates between sync versions.
      // Since this is all generated, we're going to delete after the first.
      //
      for (let i = 1, m = r.items.length; i < m; i++) {
        await joplin.data.delete(['notes', r.items[i].id]);
      }
      console.log(`Query 'sourceurl:${id}' had multiple results (${r.items.length}). Deleted all but first.`);
    }
    return r.items[0];
  }


  /** Computes the value field for a given specific note ID. */
  specificNoteValue(id: string) {
    return Db.SOURCE_URL_PREFIX + id;
  }


  /** Returns the ID for the specificNote corresponding to the given note.
   * */
  logNoteName(id: string) {
    return `note-${id}`;
  }
}


/** A class for dealing with log notes. */
class LogRecord {
  blocksOfContent: Array<RememberBlock> = [];
  blocksTracked: Array<LogBlockRecord> = [];
  logNote: any;
  note_id: string;
  note_title: string;
  pg: PropertyGrid;

  static async create(db: Db, note: any) {
    const logPg = new PropertyGrid();
    const logDoc = {
      title: `${Db.DB_NAME} ${note.title}`,
      source_url: db.specificNoteValue(db.logNoteName(note.id)),
      body: `[${note.title}](:/${note.id})\n${logPg.toString()}\n\n`,
      parent_id: db.logFolder,
    } as any;
    const r = await joplin.data.post(['notes'], null, logDoc);
    logDoc.id = r.id;
    return new LogRecord(logDoc);
  }

  constructor(logNote) {
    let m;

    this.logNote = logNote;

    m = (/^\[(.*?)\]\(:\/([a-z0-9]+)\)/).exec(this.logNote.body);
    if (m === null) {
      throw new Error(`Could not find note_id from ${this.logNote.body}`);
    }
    this.note_title = m[1];
    this.note_id = m[2];
    console.log(`Loading log note for ${this.note_id}`);
    //console.log(this.logNote.body);

    m = (/^(\|(.|\n\|)*\|)\s*($|[^|])/gm).exec(this.logNote.body);
    if (m === null) {
      throw new Error(`Could not find log's property grid? ${this.logNote.body}`);
    }
    this.pg = new PropertyGrid();
    this.pg.load(m[1]);

    const r3 = /(^|\n)# (\S+)(.*?)(?=\n#|$)/gs;
    while ((m = r3.exec(this.logNote.body)) !== null) {
      //console.log(`Found LogBlockRecord for ${this.note_id} -- ${m[2]}`);
      const table = new NoteTable();
      table.load(m[3].trim());
      this.blocksTracked.push(new LogBlockRecord(m[2], table));
    }
  }


  getLogBlockForContent(id: string) {
    for (const b of this.blocksTracked) {
      if (b.blockId === id) return b;
    }
    throw new Error(`Could not find ${id}`);
  }


  /** Given a note (with title, body, source_url), load blocksOfContent into
   * this log document.
   *
   * Might overwrite the given note! Basically, each remember block needs a
   * unique ID, and this writes those new IDs back out to the source note. That
   * is the only change joplin-plugin-remember makes outside of its own
   * notebook.
   * */
  async loadBlocks(note: any) {
    console.log(`Finding content in ${note.id} / ${note.title}`);

    // Update title, if needed.
    this.note_title = note.title;

    const trackedBlocks = {};
    for (const b of this.blocksTracked) {
      trackedBlocks[b.blockId] = b;
    }

    let bodyChanged = false;
    let newBody = [];
    let lastMatchIndex = 0;

    this.blocksOfContent = [];
    for (const match of findRememberBlocks(note.body)) {
      const b = new RememberBlock(this, match);
      this.blocksOfContent.push(b);

      if (b.id === null) {
        bodyChanged = true;
        b.id = this.makeNewBlockId();
      }

      // Update body either way, in case another block changes
      if (lastMatchIndex !== match.start) {
        newBody.push(note.body.substring(lastMatchIndex, match.start));
      }
      newBody.push(b.toString());
      lastMatchIndex = match.stop;

      // Make a new log entry, if needed
      if (trackedBlocks[b.id] === undefined) {
        const table = new NoteTable();
        table.headers = ['date', 'reviewNum', 'userRating', 'efactor', 'daysToNext'];
        const tb = new LogBlockRecord(b.id, table);
        this.blocksTracked.push(tb);
        trackedBlocks[b.id] = tb;
      }
    }

    if (this.pg.properties.blockIdMax === undefined) {
      // This can happen when blocks are deleted or joplin-plugin-remember
      // gets re-initialized through the deletion of its notebook. In this case,
      // re-assign to highest known id.
      let idMax = 0;
      for (const b of this.blocksTracked) {
        idMax = Math.max(idMax, parseInt(b.blockId));
      }
      this.pg.properties.blockIdMax = idMax;
    }

    if (bodyChanged) {
      console.log(`Writing new block IDs for ${note.id} / ${note.title}`);
      if (lastMatchIndex !== note.body.length) {
        newBody.push(note.body.substring(lastMatchIndex));
      }
      await joplin.data.put(['notes', note.id], null, {
        body: newBody.join(''),
      });
    }
  }

  /** Allocate and remember a new block id. */
  makeNewBlockId() {
    if (this.pg.properties.blockIdMax === undefined) {
      this.pg.properties.blockIdMax = 0;
    }
    this.pg.properties.blockIdMax += 1;
    return this.pg.properties.blockIdMax.toString();
  }

  logScore(blockId: string, date: string, reviewNum: number, score: number) {
    let seen = false;
    for (const b of this.blocksTracked) {
      console.log(`Comparing ${b.blockId} to ${blockId} in ${this.note_id}`);
      if (b.blockId !== blockId) continue;
      seen = true;

      // Development, maybe someone came back to a quiz later in the day --
      // remove records with same day
      while (b.data.rowData.length !== 0) {
        const lastRecord = b.data.rowDataGet(0);
        if (lastRecord.date !== date) break;
        b.data.rowData.splice(0, 1);
      }

      let efactor: number = 1.3, daysToNext: number = 1;
      if (b.data.rowData.length !== 0) {
        const lastRecord = b.data.rowDataGet(0);
        if (lastRecord.date > date) {
          // Don't update the past once it's no longer the most recent
          break;
        }

        // Update per SM-2
        efactor = lastRecord.efactor + (0.1 - (5 - score) * (0.08 + (5 - score) * 0.02));
        efactor = Math.max(efactor, 1.3);

        if (score < 3) daysToNext = 1;
        else if (lastRecord.daysToNext === 1) daysToNext = 6;
        else daysToNext = lastRecord.daysToNext * efactor;
      }

      const data = b.data.rowDataCreate({
        date: date,
        reviewNum: reviewNum,
        userRating: score,
        efactor: efactor,
        daysToNext: daysToNext,
      });
      b.data.rowData.splice(0, 0, data);

      break;
    }

    if (!seen) throw new Error(`Could not find ${blockId} in log for ${this.note_id}`);
  }

  async write() {
    const r = [];
    r.push(`[${this.note_title}](:/${this.note_id})\n`);
    r.push(this.pg.toString());
    r.push('\n');
    for (const block of this.blocksTracked) {
      r.push(block.toString());
    }
    await joplin.data.put(['notes', this.logNote.id], null, {
      body: r.join(''),
    });
  }
}


/** Within a LogRecord, this is the information for a single remember block. */
class LogBlockRecord {
  constructor(public blockId: string, public data: NoteTable) {
  }


  needsQuiz(date: string, reviewNumber: number) {
    if (this.data.rowData.length === 0) return true;

    const info = this.data.rowDataGet(0);
    const d = info.date;
    const lastDate = new Date();
    lastDate.setFullYear(d.substring(0, 4));
    lastDate.setMonth(d.substring(4, 6) - 1);
    lastDate.setDate(d.substring(6, 8));
    lastDate.setDate(lastDate.getDate() + info.daysToNext);

    let nextDate = dateToFormat(lastDate);
    if (date >= nextDate) return true;
    return false;
  }


  /** May return undefined to not quiz on this element.
   * */
  makeQuiz(note: any) {
    const r = [];

    let text: string|undefined;
    for (const m of findRememberBlocks(note.body)) {
      if (m.id === this.blockId) {
        text = m.text;
        break
      }
    }

    if (text === undefined) {
      // This block was deleted or otherwise cannot be found.
      return;
    }

    // Always terminates in ```
    const textTrunc = text;
    let questions: Array<{context: Array<string>, content: Array<string>}> = [];

    const wholeBodyMatch = (/```remember.*?\n(.*?)^```/ms).exec(textTrunc);
    if (wholeBodyMatch === null) {
      // Bad parse?
      console.log(`Bad remember in: ${note.id}`);
      return;
    }

    let body = wholeBodyMatch[1];
    if (body.trim().toLowerCase().startsWith('q: ')) {
      // New style -- q: headers for context, answer is everything between those
      console.log(JSON.stringify(body));
      let re = /(^|\n)q: (.*?)\n(.*?)(?=\nq: |$)/isg;
      let m: any;
      while (null !== (m = re.exec(body))) {
        questions.push({context: [m[2]], content: [m[3]]});
      }
    }
    else {
      // Old style -- answer is implicit, q lives in a "# Context" block
      let nextSection = body.indexOf('\n# ');
      let question = {context: [], content: []};
      questions.push(question);
      if (nextSection === -1) {
        // Use note as context
        question.content.push(body.trim());
      }
      else {
        question.content.push(body.substring(0, nextSection+1).trim());
        body = body.substring(nextSection+1);
        console.log(JSON.stringify(body));
        const m = (/^# context(.*?)(\n# |$)/is).exec(body);
        if (m !== null) {
          question.context.push(m[1].trim());
        }
      }
    }

    for (const q of questions) {
      arrayShuffle(q.context);
      q.context.push(note.title);

      r.push('```remember-review\n');
      r.push(JSON.stringify({context: q.context,
          content: q.content, note: {id: note.id, title: note.title}}));
      r.push('\n```\n\n');
    }

    // Append quiz part -- must always be prefix by two newlines
    r.push('\nLevel of recall:\n');
    for (let i = 5; i >= 0; --i) {
      r.push(`- [ ] ${i}\n`);
    }
    r.push(`\n<span style="display:none">\nID: ${note.id}:${this.blockId}</span>`);
    return r.join('');
  }


  toString() {
    const r = [];
    r.push(`# ${this.blockId}\n`);
    r.push(this.data.toString());
    return r.join('');
  }
}


/** Content block within a note -- temporary class. */
class RememberBlock {
  get id(): string|null {
    return this.blockContent.id;
  }
  set id(v: string|null) {
    this.blockContent.id = v;
  }

  constructor(public logRecord: LogRecord, public blockContent: RememberBlockMatch) {
  }


  toString() {
    const lines = this.blockContent.text.split('\n');
    if (!lines[0].startsWith('```remember')) throw new Error(`Bad first line? ${lines[0]}`);
    lines[0] = '```remember ' + this.id;
    return lines.join('\n');
  }
}


/** A class for dealing with review notes. */
class ReviewRecord {
  data = new PropertyGrid();
  date: string;
  sections: Array<ReviewSection> = [];

  constructor(public reviewNote) {
    this.date = this.reviewNote.title.substring(0, 8);

    console.log(`Loading review ${this.reviewNote.title}`);

    let m;
    const r = /(^|\n)# (\d+)\n(.*?)(?=$|\n# )/gs;
    while ((m = r.exec(this.reviewNote.body)) !== null) {
      console.log(`Found question ${m[2]}`);
      this.sections.push(new ReviewSection(m[2], m[3]));
    }

    const data = (/\n# Data\n(.*?)$/gs).exec(this.reviewNote.body);
    if (data === null) throw new Error(`No data in ${reviewNote.id}?`);

    this.data.load(data[1]);
  }

  get properties() {
    return this.data.properties;
  }

  get reviewNumber(): number {
    return this.data.properties.reviewNumber;
  }


  /** Delete sections without responses.
   *
   * Returns true if anything was deleted.
   * */
  cleanupSections() {
    let bodyChanged = false;
    for (let i = this.sections.length - 1; i > -1; i -= 1) {
      if (this.sections[i].score === null) {
        bodyChanged = true;
        this.sections.splice(i, 1);
      }
    }
    return bodyChanged;
  }


  async write() {
    let body = [];
    for (let s of this.sections) {
      body.push(s.toString());
    }
    body.push('# Data');
    body.push(this.data.toString());
    await joplin.data.put(['notes', this.reviewNote.id], null, {
      body: body.join('\n'),
      title: this.reviewNote.title,
    });
  }
}


class ReviewSection {
  block_id: string;
  note_id: string;
  score: number|null = null;
  textHeader: string;

  constructor(public questionIndex: string, textBody: string) {
    const textTrimmed = textBody.trim();
    const m = (/\n\nLevel of recall:\n((- \[([xX]| )\] \d\n)+)\n<span.*?>\nID: (\S+)<\/span>$/s).exec(textTrimmed);
    if (m === null) throw new Error(`No response data in ${textTrimmed}`);

    this.textHeader = textTrimmed.substring(0, m.index);
    [this.note_id, this.block_id] = m[4].split(':');

    const m2 = /- \[[xX]\] (\d)/.exec(m[1]);
    if (m2 !== null) {
      this.score = parseInt(m2[1]);
    }
  }


  toString() {
    const body = [];
    body.push(`# ${this.questionIndex}\n\n`);
    body.push(this.textHeader);
    body.push('\n\nLevel of recall:\n');
    for (let i = 5; i > -1; --i) {
      body.push('- [');
      if (this.score !== i) body.push(' ');
      else body.push('x');
      body.push(`] ${i}\n`);
    }
    body.push(`\n<span style="display:none">\nID: ${this.note_id}:${this.block_id}</span>\n`);
    return body.join('');
  }
}


/** A class which has one or more columns and renders its data as a markdown
 * table. */
class NoteTable {
  headers: Array<string> = [];
  rowData: Array<Array<any>> = [];

  load(body: string) {
    this.headers = [];
    this.rowData = [];

    let seen = 0;
    for (const line of body.split('\n')) {
      if (line.trim().length === 0) continue;
      seen += 1;

      if (seen === 1) {
        if (line[0] !== '|' || line[line.length - 1] !== '|') {
          throw new Error(`Unexpected line: ${line}`);
        }

        this.headers = line.substring(2, line.length - 2).split(' | ');
      }
      else if (seen === 2) {
        if (!line.startsWith('| :----: |')) {
          throw new Error(`Unexpected line: ${line}`);
        }
      }
      else {
        const matchStr = '^\\| ' + this.headers.map(x => '(.*)').join(' \\| ') + ' \\|$';
        const match = new RegExp(matchStr).exec(line);
        if (match === null) {
          throw new Error(`Bad line for ${this.headers.join(', ')}, regex '${matchStr}'? ${line}`);
        }

        const arr = [];
        for (let i = 1, m = match.length; i < m; i++) {
          arr.push(JSON.parse(this._escapeUndo(match[i])));
        }
        this.rowData.push(arr);
      }
    }
  }


  rowDataCreate(obj: any) {
    const o = Object.assign({}, obj);
    const r = [];
    for (const h of this.headers) {
      const v = o[h];
      if (v === undefined) throw new Error(`cannot encode 'undefined' for ${h}!`);
      r.push(v);
      delete o[h];
    }

    const remainder = Object.entries(o);
    if (remainder.length !== 0) throw new Error(`Unrecognized parts: ${remainder}`);

    return r;
  }


  rowDataGet(idx: number) {
    const rowobj = {} as any;
    const h = this.headers;
    const row = this.rowData[idx];
    for (let i = 0, m = h.length; i < m; i++) {
      rowobj[h[i]] = row[i];
    }
    return rowobj;
  }


  *rows() {
    const h = this.headers;
    for (let i = 0, m = this.rowData.length; i < m; i++) {
      yield this.rowDataGet(i);
    }
  }


  toString() {
    const r = [];
    r.push('| ' + this.headers.join(' | ') + ' |');
    r.push('| ' + this.headers.map(x => ':----:').join(' | ') + ' |');
    for (const vals of this.rowData) {
      const rowVals = vals.map(x => this._escape(JSON.stringify(x)));
      r.push('| ' + rowVals.join(' | ') + ' |');
    }
    r.push('');  // Always end in empty newline
    return r.join('\n');
  }

  _escape(v: string) {
    if (v === undefined) throw new Error('Cannot serialize undefined; use null');
    return v.replace('\\', '\\\\').replace('|', '\\|');
  }

  _escapeUndo(v: string) {
    return v.replace('\\|', '|').replace('\\\\', '\\');
  }
}


/** A class which tracks properties (key/value) and can store them in Markdown.
 * */
class PropertyGrid {
  properties: {[key: string]: any} = {};

  load(body: string) {
    this.properties = {};

    const nt = new NoteTable();
    nt.load(body);
    if (nt.headers.length !== 2 || nt.headers[0] !== 'Key' || nt.headers[1] !== 'Value') {
      throw new Error(`Unrecognized PropertyGrid: ${body}`);
    }
    for (const row of nt.rows()) {
      this.properties[row.Key] = row.Value;
    }
  }


  toString() {
    const under = new NoteTable();
    under.headers = ['Key', 'Value'];
    under.rowData = Object.entries(this.properties);
    return under.toString();
  }
}

/** In-place shuffle of array, via Fisher-Yates. */
function arrayShuffle(arr: Array<any>) {
  let idx = arr.length, randidx = 0;
  let tmp: any;

  while (idx !== 0) {
    randidx = Math.floor(Math.random() * idx);
    idx--;

    tmp = arr[idx];
    arr[idx] = arr[randidx];
    arr[randidx] = tmp;
  }
}

/** Converts Date to YYYYMMDD */
function dateToFormat(d: Date) {
    const nowyyyy = d.getFullYear();
    let nowmm: number|string = d.getMonth() + 1;
    if (nowmm < 10) nowmm = '0' + nowmm;
    let nowdd: number|string = d.getDate();
    if (nowdd < 10) nowdd = '0' + nowdd;
    return `${nowyyyy}${nowmm}${nowdd}`;
}

async function* paginatedData(path, query=undefined) {
  if (query === undefined) query = {};
  query = Object.assign({}, query);

  let page: number = 1;
  while (true) {
    const r = await joplin.data.get(path, query);
    for (const i of r.items) {
      yield i;
    }
    if (!r.has_more) break;

    page += 1;
    query.page = page;
  }
}

