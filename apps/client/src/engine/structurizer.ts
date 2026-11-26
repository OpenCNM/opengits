export interface NavNode {
 name: string;
 title: string;
 shortTitle?: string;
 type: 'file' | 'directory';
 path: string;
 url: string;
 root?: boolean;
 children?: NavNode[];
}
