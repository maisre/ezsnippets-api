import * as mongoose from 'mongoose';

export const SnippetSchema = new mongoose.Schema({
  html: String,
  css: String,
  js: String,
  type: String,
});
