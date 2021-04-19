import joplin from 'api';

/** Looks like we'll need a CodeMirror plugin (https://github.com/CalebJohn/joplin-math-mode/blob/main/src/mathMode.ts)
 * as well as scanning note bodies for (newline + ```remember... newline ```).
 * */

joplin.plugins.register({
	onStart: async function() {
		console.info('joplin-plugin-remember plugin started!');

    const db = new Db();
    await db.init();

    while (true) {
      try {
        await db.scan();
      }
      catch (e) {
        console.error(e);
      }

      // Only do so once per minute or so
      await new Promise((resolve) => setTimeout(resolve, 60 * 1000));
    }
	},
});


class Db {
  static DB_NAME = 'Remember-DB';
  static DB_REVIEW_NAME = 'Remember-Review';
  static SOURCE_URL_PREFIX = 'joplin-remember/'

  databaseFolder: null|string = null;
  reviewFolder: null|string = null;

  async init() {
    // Find database folder.
    for await (const f of paginatedData(['folders'])) {
      if (f.parent_id.length !== 0) continue;
      if (f.title === Db.DB_NAME) {
        this.databaseFolder = f.id;
        console.log(`Found existing databaseFolder ${f.id}`);
        break;
      }
    }

    if (this.databaseFolder === null) {
      console.log(`Could not find databaseFolder ${Db.DB_NAME}; creating`);
      const response = await joplin.data.post(['folders'], null, {
        title: Db.DB_NAME,
      });
      this.databaseFolder = response.id;
    }

    // Ensure the 'Review' folder exists
    for await (const f of paginatedData(['folders'])) {
      if (f.parent_id !== this.databaseFolder) continue;
      if (f.title === Db.DB_REVIEW_NAME) {
        this.reviewFolder = f.id;
        console.log(`Found existing reviewFolder ${f.id}`);
        break;
      }
    }
    if (this.reviewFolder === null) {
      console.log(`Could not find reviewFolder ${Db.DB_REVIEW_NAME}; creating`);
      const response = await joplin.data.post(['folders'], null, {
        title: Db.DB_REVIEW_NAME,
        parent_id: this.databaseFolder,
      });
      this.reviewFolder = response.id;
    }
  }


  /** Scan the database for anything which was updated before today (that is,
   * yesterday). This is important because we assume the user may be editing
   * or re-editing anything from today.
   * */
  async scan() {
    let metadata = await specificNote('metadata');
    if (metadata === null) {
      metadata = await joplin.data.post(['notes'], null, {
        title: 'Metadata',
        parent_id: this.databaseFolder,
        body: new PropertyGrid().toString(),
        source_url: specificNoteValue('metadata'),
      });
    }

    const pg = new PropertyGrid();
    pg.load(metadata.body);

    const now = new Date();
    const nowyyyy = now.getFullYear();
    let nowmm: number|string = now.getMonth() + 1;
    if (nowmm < 10) nowmm = '0' + nowmm;
    let nowdd: number|string = now.getDate();
    if (nowdd < 10) nowdd = '0' + nowdd;
    let newLimit = `${nowyyyy}${nowmm}${nowdd}`;

    let lastUpdated = pg.properties.last_updated;
    console.log(`Considering update... ${newLimit} / ${lastUpdated}`);
    if (newLimit === lastUpdated) {
      // Up to date, nothing to do.
      return;
    }

    let loader;
    if (lastUpdated === undefined) {
      loader = paginatedData(['notes'], {fields: ['id', 'body']});
    }
    else {
      loader = paginatedData(['search'], {
        query: `updated:${lastUpdated} -updated:${newLimit}`,
        fields: ['id', 'body'],
      });
    }
    for await (const n of loader) {
      // This note was updated... process.
    }

    // TODO now re-scan loaded notes, looking for items to integrate into the
    // reminder system. Then make new reminder note for this day.

    pg.properties.last_updated = newLimit;
    await joplin.data.put(['notes', metadata.id], null, {
      body: pg.toString(),
    });
    console.log(`Set body to: ${pg.toString()}`);
  }
}


/** A class which tracks properties (key/value) and can store them in Markdown.
 * */
class PropertyGrid {
  properties: {[key: string]: string} = {};

  load(body: string) {
    this.properties = {};

    let seen = 0;
    for (const line of body.split('\n')) {
      if (line.trim().length === 0) continue;
      seen += 1;

      if (seen === 1) {
        if (line !== '| Key | Value |') {
          throw new Error(`Unexpected line: ${line}`);
        }
      }
      else if (seen === 2) {
        if (line !== '| :----: | :----: |') {
          throw new Error(`Unexpected line: ${line}`);
        }
      }
      else {
        const match = /\| (.*) \| (.*) \|/.exec(line);
        if (match === null) {
          throw new Error(`Bad line? ${line}`);
        }

        this.properties[this._escapeUndo(match[1])] = this._escapeUndo(match[2]);
      }
    }
  }


  toString() {
    const r = [];
    r.push('| Key | Value |');
    r.push('| :----: | :----: |');
    for (const [k, v] of Object.entries(this.properties)) {
      r.push(`| ${this._escape(k)} | ${this._escape(v)} |`);
    }

    return r.join('\n');
  }

  _escape(v: string) {
    return v.replace('\\', '\\\\').replace('|', '\\|');
  }

  _escapeUndo(v: string) {
    return v.replace('\\|', '|').replace('\\\\', '\\');
  }
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


/** Retrieves a note (with Joplin's internal ID) based on a deterministic ID.
 *
 * This is achieved by hijacking the 'sourceurl' attribute of notes.
 * */
async function specificNote(id: string) {
  const r = await joplin.data.get(['search'], {
    query: 'sourceurl:' + specificNoteValue(id),
    fields: ['id', 'body'],
  });
  if (r.items.length === 0) return null;
  if (r.items.length > 1) throw new Error(`Query 'sourceurl:${id}' had more than 1 result`);
  return r.items[0];
}


/** Computes the value field for a given specific note ID. */
function specificNoteValue(id: string) {
  return Db.SOURCE_URL_PREFIX + id;
}

