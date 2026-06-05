export interface TodoFixture {
  id: number;
  title: string;
  completed: boolean;
  status: string;
}

export const todosBefore: TodoFixture[] = [
  { id: 1, title: "Ship", completed: false, status: "in_progress" },
  { id: 2, title: "Review", completed: false, status: "queued" },
];

export const todosAfterStatusChange: TodoFixture[] = [
  { id: 1, title: "Ship", completed: false, status: "complete" },
  { id: 2, title: "Review", completed: false, status: "queued" },
];
