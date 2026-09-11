export type TaskStatus = 'backlog' | 'todo' | 'doing' | 'hold' | 'done';
export type TaskPriority = 'high' | 'mid' | 'low';

export interface TaskFields {
	text: string;
	project: string | null;
	priority: TaskPriority | null;
	dueDate: string | null;
	startDate: string | null;
	delayReason: string | null;
}

// 小タスク（サブタスク）も親タスクと同じ 🛫開始日 / 📅期日 のマーカーを持てる。
// ガントチャートに小タスク行として並べられるようにするため。
export interface SubTaskFields {
	text: string;
	startDate: string | null;
	dueDate: string | null;
}

export interface SubTask extends SubTaskFields {
	line: number;
	checked: boolean;
}

export interface TaskItem extends TaskFields {
	filePath: string;
	line: number;
	checked: boolean;
	status: TaskStatus;
	startedAt: string | null;
	completedAt: string | null;
	subtasks: SubTask[];
}
