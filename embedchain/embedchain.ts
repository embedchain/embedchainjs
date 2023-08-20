/* eslint-disable max-classes-per-file */
import type { Collection } from 'chromadb';
import type { QueryResponse } from 'chromadb/dist/main/types';
import * as fs from 'fs';
import { Document } from 'langchain/document';
import type { ChatCompletionRequestMessage } from 'openai';
import { Configuration, OpenAIApi } from 'openai';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

import type { BaseChunker } from './chunkers';
import { PdfFileChunker, QnaPairChunker, WebPageChunker } from './chunkers';
import type { BaseLoader } from './loaders';
import { LocalQnaPairLoader, PdfFileLoader, WebPageLoader } from './loaders';
import type {
  DataDict,
  DataType,
  FormattedResult,
  Input,
  LocalInput,
  Method,
  RemoteInput,
} from './models';
import { ChromaDB } from './vectordb';
import type { BaseVectorDB } from './vectordb/BaseVectorDb';

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

class EmbedChain {
  dbClient: any;

  // TODO: Definitely assign
  collection!: Collection;

  userAsks: [DataType, Input][] = [];

  initApp: Promise<void>;

  collectMetrics = true;

  sId: string; // sessionId

  constructor(db: BaseVectorDB | null = null) {
    if (!db) {
      this.initApp = this.setupChroma();
    } else {
      this.initApp = this.setupOther(db);
    }

    // Send anonymous telemetry
    this.sId = uuidv4();
    this.sendTelemetryEvent('init');
  }

  async setupChroma(): Promise<void> {
    const db = new ChromaDB();
    await db.initDb;
    this.dbClient = db.client;
    if (db.collection) {
      this.collection = db.collection;
    } else {
      // TODO: Add proper error handling
      console.error('No collection');
    }
  }

  async setupOther(db: BaseVectorDB): Promise<void> {
    await db.initDb;
    // TODO: Figure out how we can initialize an unknown database.
    // this.dbClient = db.client;
    // this.collection = db.collection;
    this.userAsks = [];
  }

  static getLoader(dataType: DataType) {
    const loaders: { [t in DataType]: BaseLoader } = {
      pdf_file: new PdfFileLoader(),
      web_page: new WebPageLoader(),
      qna_pair: new LocalQnaPairLoader(),
    };
    return loaders[dataType];
  }

  static getChunker(dataType: DataType) {
    const chunkers: { [t in DataType]: BaseChunker } = {
      pdf_file: new PdfFileChunker(),
      web_page: new WebPageChunker(),
      qna_pair: new QnaPairChunker(),
    };
    return chunkers[dataType];
  }

  public async add(dataType: DataType, url: RemoteInput) {
    const loader = EmbedChain.getLoader(dataType);
    const chunker = EmbedChain.getChunker(dataType);
    this.userAsks.push([dataType, url]);
    await this.loadAndEmbed(loader, chunker, url);
    this.sendTelemetryEvent('add');
  }

  public async addLocal(dataType: DataType, content: LocalInput) {
    const loader = EmbedChain.getLoader(dataType);
    const chunker = EmbedChain.getChunker(dataType);
    this.userAsks.push([dataType, content]);
    await this.loadAndEmbed(loader, chunker, content);
    this.sendTelemetryEvent('add_local');
  }

  protected async loadAndEmbed(loader: any, chunker: BaseChunker, src: Input) {
    const embeddingsData = await chunker.createChunks(loader, src);
    let { documents, ids, metadatas } = embeddingsData;

    const existingDocs = await this.collection.get({ ids });
    const existingIds = new Set(existingDocs.ids);

    if (existingIds.size > 0) {
      const dataDict: DataDict = {};
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        if (!existingIds.has(id)) {
          dataDict.id = { doc: documents[i], meta: metadatas[i] };
        }
      }

      if (Object.keys(dataDict).length === 0) {
        console.log(`All data from ${src} already exists in the database.`);
        return;
      }
      ids = Object.keys(dataDict);
      const dataValues = Object.values(dataDict);
      documents = dataValues.map(({ doc }) => doc);
      metadatas = dataValues.map(({ meta }) => meta);
    }

    await this.collection.add({ documents, metadatas, ids });
    console.log(
      `Successfully saved ${src}. Total chunks count: ${await this.collection.count()}`
    );
  }

  static async formatResult(
    results: QueryResponse
  ): Promise<FormattedResult[]> {
    return results.documents[0].map((document: any, index: number) => {
      const metadata = results.metadatas[0][index] || {};
      // TODO: Add proper error handling
      const distance = results.distances ? results.distances[0][index] : null;
      return [new Document({ pageContent: document, metadata }), distance];
    });
  }

  static async getOpenAiAnswer(prompt: string) {
    const messages: ChatCompletionRequestMessage[] = [
      { role: 'user', content: prompt },
    ];
    const response = await openai.createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages,
      temperature: 0,
      max_tokens: 1000,
      top_p: 1,
    });
    return (
      response.data.choices[0].message?.content ??
      'Response could not be processed.'
    );
  }

  protected async retrieveFromDatabase(inputQuery: string) {
    const result = await this.collection.query({
      nResults: 1,
      queryTexts: [inputQuery],
    });
    const resultFormatted = await EmbedChain.formatResult(result);
    const content = resultFormatted[0][0].pageContent;
    return content;
  }

  static generatePrompt(inputQuery: string, context: any) {
    const prompt = `Use the following pieces of context to answer the query at the end. If you don't know the answer, just say that you don't know, don't try to make up an answer.\n${context}\nQuery: ${inputQuery}\nHelpful Answer:`;
    return prompt;
  }

  static async getAnswerFromLlm(prompt: string) {
    const answer = await EmbedChain.getOpenAiAnswer(prompt);
    return answer;
  }

  public async query(inputQuery: string) {
    const context = await this.retrieveFromDatabase(inputQuery);
    const prompt = EmbedChain.generatePrompt(inputQuery, context);
    const answer = await EmbedChain.getAnswerFromLlm(prompt);
    this.sendTelemetryEvent('query');
    return answer;
  }

  public async dryRun(input_query: string) {
    const context = await this.retrieveFromDatabase(input_query);
    const prompt = EmbedChain.generatePrompt(input_query, context);
    return prompt;
  }

  protected async sendTelemetryEvent(method: Method, extraMetadata?: object) {
    if (!this.collectMetrics) {
      return;
    }
    const url = 'https://api.embedchain.ai/api/v1/telemetry/';

    // Read package version from filesystem (because it's not in the ts root dir)
    const packageJsonPath = path.join(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    const metadata = {
      s_id: this.sId,
      version: packageJson.version,
      method,
      language: 'js',
      ...extraMetadata,
    };

    const maxRetries = 3;

    // Retry the fetch
    for (let i = 0; i < maxRetries; i += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await fetch(url, {
          method: 'POST',
          body: JSON.stringify({ metadata }),
        });

        if (response.ok) {
          // Break out of the loop if the request was successful
          break;
        } else {
          // Log the unsuccessful response (optional)
          console.error(
            `Attempt ${i + 1} failed with status:`,
            response.status
          );
        }
      } catch (error) {
        // Log the error (optional)
        console.error(`Attempt ${i + 1} failed with error:`, error);
      }

      // If this was the last attempt, throw an error or handle the failure
      if (i === maxRetries - 1) {
        throw new Error('Max retries reached');
      }
    }
  }
}

class EmbedChainApp extends EmbedChain {
  // The EmbedChain app.
  // Has two functions: add and query.
  // adds(dataType, url): adds the data from the given URL to the vector db.
  // query(query): finds answer to the given query using vector database and LLM.
}

export { EmbedChainApp };
