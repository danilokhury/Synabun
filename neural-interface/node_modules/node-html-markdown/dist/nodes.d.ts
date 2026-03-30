import * as NHParser from 'node-html-parser';
import { CommentNode, NodeType } from 'node-html-parser';
export { NodeType, CommentNode };
type NodeBase = {
    preserve?: boolean;
};
export type HtmlNode = (NHParser.Node | Node) & NodeBase;
export type ElementNode = (NHParser.HTMLElement | HTMLElement) & NodeBase;
export type TextNode = (NHParser.TextNode) & NodeBase;
export declare const isTextNode: (node: HtmlNode) => node is TextNode;
export declare const isCommentNode: (node: HtmlNode) => node is CommentNode;
export declare const isElementNode: (node: HtmlNode) => node is ElementNode;
