import joplin from 'api';

joplin.plugins.register({
	onStart: async function() {
		console.info('Test plugin started!');

    const folders = await joplin.data.get(['folders']);
    console.log(folders);

    // Query for 'updated:20210419' returns all notes updated on or since
    // 2021-04-19. 'updated:year-0' returns all notes updated in the current
    // year...
    const recent = await joplin.data.get(['search'], {query: 'updated:20210419'});
    console.log(recent);

    const db = new Db();
    await db.init();
	},
});


class Db {
  static DB_NAME = 'Remember-DB';

  databaseFolder: null|string = null;

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

