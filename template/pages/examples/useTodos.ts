import { useState, useEffect } from "react";

export interface Todo {
  id: number;
  text: string;
  completed: boolean;
}

const STORAGE_KEY = "scratch-demo-todos";

let globalTodos: Todo[] | null = null;
let listeners: Set<(todos: Todo[]) => void> = new Set();

function getTodos(): Todo[] {
  if (globalTodos === null) {
    if (typeof window === "undefined") {
      globalTodos = [];
    } else {
      const stored = localStorage.getItem(STORAGE_KEY);
      globalTodos = stored ? JSON.parse(stored) : [];
    }
  }
  return globalTodos;
}

function saveToStorage(todos: Todo[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
}

function notifyListeners() {
  listeners.forEach((listener) => listener(getTodos()));
}

export function useTodos() {
  const [todos, setTodos] = useState<Todo[]>(() => getTodos());

  useEffect(() => {
    // Sync state with global on mount (in case another component already loaded)
    setTodos(getTodos());

    // Subscribe to changes
    const listener = (newTodos: Todo[]) => setTodos(newTodos);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const updateTodos = (newTodos: Todo[]) => {
    globalTodos = newTodos;
    saveToStorage(newTodos);
    notifyListeners();
  };

  const addTodo = (text: string) => {
    if (!text.trim()) return;
    updateTodos([...getTodos(), { id: Date.now(), text: text.trim(), completed: false }]);
  };

  const toggleTodo = (id: number) => {
    updateTodos(getTodos().map((t) => (t.id === id ? { ...t, completed: !t.completed } : t)));
  };

  const deleteTodo = (id: number) => {
    updateTodos(getTodos().filter((t) => t.id !== id));
  };

  const reset = () => {
    updateTodos([]);
  };

  return { todos, addTodo, toggleTodo, deleteTodo, reset };
}
