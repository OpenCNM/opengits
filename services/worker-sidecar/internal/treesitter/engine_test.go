package treesitter

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAllTop20Languages(t *testing.T) {
	ctx := context.Background()
	engine, err := NewEngine(ctx)
	require.NoError(t, err)
	defer engine.Close()

	cases := []struct {
		lang       string
		source     string
		expectName string
		expectKind string
	}{
		{"python", "def hello_world():\n    pass\n", "hello_world", "function"},
		{"go", "package p\nfunc DoWork() {}\n", "DoWork", "function"},
		{"typescript", "export function processTask(): void {}\n", "processTask", "function"},
		{"tsx", "export function Component(): JSX.Element { return null; }\n", "Component", "function"},
		{"javascript", "function calculateTotal() {}\n", "calculateTotal", "function"},
		{"rust", "pub fn compute_hash() {}\n", "compute_hash", "function"},
		{"java", "public class Service { public void execute() {} }\n", "Service", "type"},
		{"c", "void handle_request() {}\n", "handle_request", "function"},
		{"cpp", "class Controller {}; void start() {}\n", "Controller", "type"},
		{"csharp", "public class Worker { public void Run() {} }\n", "Worker", "type"},
		{"php", "<?php function sendMail() {} class Client {}\n", "sendMail", "function"},
		{"ruby", "class Parser\n  def parse\n  end\nend\n", "Parser", "type"},
		{"kotlin", "class Runner { fun start() {} }\n", "Runner", "type"},
		{"swift", "class AppRouter { func navigate() {} }\n", "AppRouter", "type"},
		{"dart", "void login() {}\n", "login", "function"},
		{"scala", "class Worker { def process(): Unit = {} }\n", "Worker", "type"},
		{"bash", "function deploy_app() {\n  echo \"deploying\"\n}\n", "deploy_app", "function"},
		{"lua", "function setup_env()\nend\n", "setup_env", "function"},
		{"elixir", "defmodule WebServer do\n  def start do\n  end\nend\n", "WebServer", "type"},
		{"zig", "fn initEngine() void {}\n", "initEngine", "function"},
		{"sql", "CREATE TABLE accounts (id INT);\n", "accounts", "type"},
	}

	for _, tc := range cases {
		t.Run(tc.lang, func(t *testing.T) {
			res, err := engine.ParseAndExtract(ctx, tc.lang, []byte(tc.source))
			require.NoError(t, err, "ParseAndExtract failed for %s", tc.lang)
			require.NotNil(t, res)

			found := false
			for _, s := range res.Symbols {
				if s.Name == tc.expectName {
					assert.Equal(t, tc.expectKind, s.Kind, "kind mismatch for %s", tc.expectName)
					found = true
					break
				}
			}
			assert.True(t, found, "expected symbol %q not found for %s, got: %+v", tc.expectName, tc.lang, res.Symbols)
		})
	}
}

func TestEngineBasicLanguages(t *testing.T) {
	ctx := context.Background()
	engine, err := NewEngine(ctx)
	require.NoError(t, err)
	defer engine.Close()

	tests := []struct {
		name         string
		lang         string
		source       string
		expectedSyms []SymbolMatch
		minCalls     int
	}{
		{
			name: "Python function, class and calls",
			lang: "python",
			source: `# A comment with def fake_func():
class DataProcessor:
    def process(self, item):
        validate(item)
        return transform(item)

def calculate_sum(a, b):
    print("summing")
    return a + b
`,
			expectedSyms: []SymbolMatch{
				{Name: "DataProcessor", Kind: "type", StartLine: 2},
				{Name: "process", Kind: "function", StartLine: 3},
				{Name: "calculate_sum", Kind: "function", StartLine: 7},
			},
			minCalls: 3,
		},
		{
			name: "Go functions, types and calls",
			lang: "go",
			source: `package main

type Config struct {
	Port int
}

func NewConfig() *Config {
	initDefaults()
	return &Config{Port: 8080}
}

func (c *Config) Start() {
	listen(c.Port)
}
`,
			expectedSyms: []SymbolMatch{
				{Name: "Config", Kind: "type", StartLine: 3},
				{Name: "NewConfig", Kind: "function", StartLine: 7},
				{Name: "Start", Kind: "function", StartLine: 12},
			},
			minCalls: 2,
		},
		{
			name: "TypeScript functions, classes, interfaces",
			lang: "typescript",
			source: `// Interface comment
export interface User {
    id: string;
}

export class UserService {
    getUser(id: string): User {
        fetchUser(id);
        return { id };
    }
}

export const helper = (x: number) => {
    return doMath(x);
};
`,
			expectedSyms: []SymbolMatch{
				{Name: "User", Kind: "type", StartLine: 2},
				{Name: "UserService", Kind: "type", StartLine: 6},
				{Name: "getUser", Kind: "function", StartLine: 7},
				{Name: "helper", Kind: "function", StartLine: 13},
			},
			minCalls: 2,
		},
		{
			name: "Rust struct, trait, function",
			lang: "rust",
			source: `pub struct Server {
    port: u16,
}

pub trait Handler {
    fn handle(&self);
}

pub fn start_server(s: Server) {
    bind_port(s.port);
}
`,
			expectedSyms: []SymbolMatch{
				{Name: "Server", Kind: "type", StartLine: 1},
				{Name: "Handler", Kind: "type", StartLine: 5},
				{Name: "start_server", Kind: "function", StartLine: 9},
			},
			minCalls: 1,
		},
		{
			name: "Java class and methods",
			lang: "java",
			source: `package com.example;

public class Greeter {
    public Greeter() {
        init();
    }

    public void greet(String name) {
        System.out.println(name);
    }
}
`,
			expectedSyms: []SymbolMatch{
				{Name: "Greeter", Kind: "type", StartLine: 3},
				{Name: "Greeter", Kind: "function", StartLine: 4},
				{Name: "greet", Kind: "function", StartLine: 8},
			},
			minCalls: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := engine.ParseAndExtract(ctx, tt.lang, []byte(tt.source))
			require.NoError(t, err)
			require.NotNil(t, res)

			for _, exp := range tt.expectedSyms {
				found := false
				for _, sym := range res.Symbols {
					if sym.Name == exp.Name && sym.Kind == exp.Kind {
						assert.Equal(t, exp.StartLine, sym.StartLine, "start line for %s", sym.Name)
						found = true
						break
					}
				}
				assert.True(t, found, "expected symbol %s (%s) was not found in: %+v", exp.Name, exp.Kind, res.Symbols)
			}

			assert.GreaterOrEqual(t, len(res.CallSites), tt.minCalls, "call sites: %+v", res.CallSites)
		})
	}
}

func TestAntiFalsePositiveCommentsAndStrings(t *testing.T) {
	ctx := context.Background()
	engine, err := NewEngine(ctx)
	require.NoError(t, err)
	defer engine.Close()

	pySource := `
# def comment_func():
#     pass
# class CommentClass:
#     pass

"""
def docstring_func():
    pass
class DocstringClass:
    pass
"""

def real_func():
    msg = "def string_func(): pass"
    return msg
`
	res, err := engine.ParseAndExtract(ctx, "python", []byte(pySource))
	require.NoError(t, err)

	var symNames []string
	for _, s := range res.Symbols {
		symNames = append(symNames, s.Name)
	}

	assert.Contains(t, symNames, "real_func")
	assert.NotContains(t, symNames, "comment_func")
	assert.NotContains(t, symNames, "CommentClass")
	assert.NotContains(t, symNames, "docstring_func")
	assert.NotContains(t, symNames, "DocstringClass")
	assert.NotContains(t, symNames, "string_func")
}

func TestPythonTopLevelVariables(t *testing.T) {
	ctx := context.Background()
	engine, err := NewEngine(ctx)
	require.NoError(t, err)
	defer engine.Close()

	src := `
from langchain import PromptTemplate

chat_prompt = PromptTemplate(template="hi")
start_goal_prompt = PromptTemplate(template="goal")
typed_prompt: PromptTemplate = PromptTemplate(template="typed")

def helper():
    local_var = 42
    return local_var
`
	res, err := engine.ParseAndExtract(ctx, "python", []byte(src))
	require.NoError(t, err)

	var symNames []string
	for _, s := range res.Symbols {
		symNames = append(symNames, s.Name)
	}

	assert.Contains(t, symNames, "chat_prompt")
	assert.Contains(t, symNames, "start_goal_prompt")
	assert.Contains(t, symNames, "typed_prompt")
	assert.Contains(t, symNames, "helper")
	assert.NotContains(t, symNames, "local_var", "local variable inside function must not be extracted as top-level symbol")
}

func TestTypeScriptAndTSXParsing(t *testing.T) {
	ctx := context.Background()
	engine, err := NewEngine(ctx)
	require.NoError(t, err)
	defer engine.Close()

	src := `export interface User {
  id: string;
}

export function login(name: string): void {
  console.log(name);
  helper();
}

class InternalService {
  process() {}
}

export const calculate = (a: number, b: number) => {
  return a + b;
};

export const chartTypeMap = {
  column: "bar"
};
`
	for _, lang := range []string{"typescript", "tsx"} {
		res, err := engine.ParseAndExtract(ctx, lang, []byte(src))
		require.NoError(t, err, "failed parsing %s", lang)
		require.NotNil(t, res)

		symMap := make(map[string]SymbolMatch)
		for _, s := range res.Symbols {
			symMap[s.Name] = s
		}

		assert.Contains(t, symMap, "User")
		assert.Equal(t, "type", symMap["User"].Kind)
		assert.Contains(t, symMap, "login")
		assert.Equal(t, "function", symMap["login"].Kind)
		assert.Contains(t, symMap, "InternalService")
		assert.Equal(t, "type", symMap["InternalService"].Kind)
		assert.Contains(t, symMap, "calculate")
		assert.Equal(t, "function", symMap["calculate"].Kind)
		assert.Contains(t, symMap, "chartTypeMap")
		assert.Equal(t, "type", symMap["chartTypeMap"].Kind)

		callNames := make(map[string]bool)
		for _, c := range res.CallSites {
			callNames[c.Name] = true
		}
		assert.True(t, callNames["helper"], "expected call site 'helper' in %s", lang)
	}
}

func BenchmarkParseAndExtract(b *testing.B) {
	ctx := context.Background()
	engine, err := NewEngine(ctx)
	if err != nil {
		b.Fatal(err)
	}
	defer engine.Close()

	src := []byte(`
package main

import "fmt"

type Service struct {
	Name string
}

func (s *Service) Run() error {
	fmt.Println("running", s.Name)
	return nil
}

func Main() {
	s := &Service{Name: "app"}
	s.Run()
}
`)

	_, _ = engine.ParseAndExtract(ctx, "go", src)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := engine.ParseAndExtract(ctx, "go", src)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func TestDynamicGrammarDiskFallback(t *testing.T) {
	tmpDir := t.TempDir()
	grammarDir := filepath.Join(tmpDir, "storage", "grammars")
	queryDir := filepath.Join(tmpDir, "storage", "queries")
	require.NoError(t, os.MkdirAll(grammarDir, 0755))
	require.NoError(t, os.MkdirAll(queryDir, 0755))

	goWasm, err := loadGrammarWasm("go")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(grammarDir, "tree-sitter-customlang.wasm"), goWasm, 0644))

	goQuery, err := loadQuery("go")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(queryDir, "customlang.scm"), goQuery, 0644))

	wasmBytes, err := loadGrammarWasm("customlang", grammarDir)
	require.NoError(t, err)
	assert.NotEmpty(t, wasmBytes)

	queryBytes, err := loadQuery("customlang", queryDir)
	require.NoError(t, err)
	assert.NotEmpty(t, queryBytes)
}

func TestProbeLanguageDefects(t *testing.T) {
	ctx := context.Background()
	engine, err := NewEngine(ctx)
	require.NoError(t, err)
	defer engine.Close()

	t.Run("Lua local function and table method", func(t *testing.T) {
		src := `
local function helper()
end

function Module.process()
end

function Module:run()
end
`
		res, err := engine.ParseAndExtract(ctx, "lua", []byte(src))
		require.NoError(t, err)
		names := make(map[string]bool)
		for _, s := range res.Symbols {
			names[s.Name] = true
		}
		assert.True(t, names["helper"], "expected 'helper' from 'local function helper()', got symbols: %+v", res.Symbols)
	})

	t.Run("Zig structs and calls", func(t *testing.T) {
		src := `
pub const Config = struct {
    port: u16,
};

pub fn start() void {
    init();
}
`
		res, err := engine.ParseAndExtract(ctx, "zig", []byte(src))
		require.NoError(t, err)
		names := make(map[string]bool)
		for _, s := range res.Symbols {
			names[s.Name] = true
		}
		assert.True(t, names["start"], "expected 'start' function")
		assert.True(t, names["Config"], "expected 'Config' struct/type, got symbols: %+v", res.Symbols)
		assert.NotEmpty(t, res.CallSites, "expected call site 'init'")
	})

	t.Run("Dart methods and calls", func(t *testing.T) {
		src := `
class Greeter {
  void greet(String name) {
    print(name);
  }
}

void main() {
  greet("hi");
}
`
		res, err := engine.ParseAndExtract(ctx, "dart", []byte(src))
		require.NoError(t, err)
		names := make(map[string]bool)
		for _, s := range res.Symbols {
			names[s.Name] = true
		}
		assert.True(t, names["Greeter"], "expected Greeter class, got symbols: %+v", res.Symbols)
		assert.True(t, names["greet"], "expected greet method, got symbols: %+v", res.Symbols)
		assert.NotEmpty(t, res.CallSites, "expected call site 'print' or 'greet', got: %+v", res.CallSites)
	})

	t.Run("Swift structs and member calls", func(t *testing.T) {
		src := `
struct UserProfile {
    var id: String
}

enum State {
    case active
}

func configure() {
    setup()
}
`
		res, err := engine.ParseAndExtract(ctx, "swift", []byte(src))
		require.NoError(t, err)
		names := make(map[string]bool)
		for _, s := range res.Symbols {
			names[s.Name] = true
		}
		assert.True(t, names["UserProfile"], "expected UserProfile struct, got symbols: %+v", res.Symbols)
		assert.True(t, names["State"], "expected State enum, got symbols: %+v", res.Symbols)
		assert.NotEmpty(t, res.CallSites, "expected call site 'setup'")
	})

	t.Run("Elixir calls", func(t *testing.T) {
		src := `
defmodule Worker do
  def perform(job) do
    execute(job)
  end
end
`
		res, err := engine.ParseAndExtract(ctx, "elixir", []byte(src))
		require.NoError(t, err)
		assert.NotEmpty(t, res.CallSites, "expected call site 'execute', got: %+v", res.CallSites)
	})

	t.Run("C header prototypes", func(t *testing.T) {
		src := `
void compute_hash(const char *data);
int get_version(void);
`
		res, err := engine.ParseAndExtract(ctx, "c", []byte(src))
		require.NoError(t, err)
		names := make(map[string]bool)
		for _, s := range res.Symbols {
			names[s.Name] = true
		}
		assert.True(t, names["compute_hash"], "expected compute_hash prototype from .h, got: %+v", res.Symbols)
	})

	t.Run("Bash function without function keyword", func(t *testing.T) {
		src := `
start() {
    echo "start"
}

function stop() {
    echo "stop"
}
`
		res, err := engine.ParseAndExtract(ctx, "bash", []byte(src))
		require.NoError(t, err)
		names := make(map[string]bool)
		for _, s := range res.Symbols {
			names[s.Name] = true
		}
		assert.True(t, names["start"], "expected 'start' from bash without 'function' keyword, got: %+v", res.Symbols)
		assert.True(t, names["stop"], "expected 'stop' from bash with 'function' keyword")
	})

	t.Run("Scala traits and calls", func(t *testing.T) {
		src := `
trait Repository {
  def findById(id: String): Option[String]
}

class UserRepo extends Repository {
  def findById(id: String): Option[String] = {
    fetchFromDb(id)
  }
}
`
		res, err := engine.ParseAndExtract(ctx, "scala", []byte(src))
		require.NoError(t, err)
		names := make(map[string]bool)
		for _, s := range res.Symbols {
			names[s.Name] = true
		}
		assert.True(t, names["Repository"], "expected trait Repository, got: %+v", res.Symbols)
		assert.True(t, names["findById"], "expected findById method, got: %+v", res.Symbols)
		assert.NotEmpty(t, res.CallSites, "expected call site 'fetchFromDb', got: %+v", res.CallSites)
	})

	t.Run("SQL views, tables, and functions", func(t *testing.T) {
		src := `
CREATE TABLE users (id INT PRIMARY KEY);
CREATE VIEW active_users AS SELECT * FROM users;
CREATE FUNCTION calculate_tax(amount DECIMAL) RETURNS DECIMAL AS 'SELECT 1;' LANGUAGE SQL;
`
		res, err := engine.ParseAndExtract(ctx, "sql", []byte(src))
		require.NoError(t, err)
		names := make(map[string]bool)
		for _, s := range res.Symbols {
			names[s.Name] = true
		}
		assert.True(t, names["users"], "expected table users")
		assert.True(t, names["active_users"], "expected view active_users")
		assert.True(t, names["calculate_tax"], "expected function calculate_tax, got: %+v", res.Symbols)
	})

	t.Run("CPP member definitions and calls", func(t *testing.T) {
		src := `
class Controller {
public:
    void init();
};

void Controller::init() {
    Service::start();
    this->run();
}
`
		ast, err := engine.DebugAST("cpp", []byte(src))
		require.NoError(t, err)
		t.Logf("CPP AST:\n%s", ast)

		res, err := engine.ParseAndExtract(ctx, "cpp", []byte(src))
		require.NoError(t, err)
		t.Logf("CPP symbols: %+v", res.Symbols)
		t.Logf("CPP calls: %+v", res.CallSites)
	})

	t.Run("Switching between CPP and Swift", func(t *testing.T) {
		_, err := engine.ParseAndExtract(ctx, "cpp", []byte("void foo() {}\n"))
		require.NoError(t, err)

		_, err = engine.ParseAndExtract(ctx, "swift", []byte("func foo() {}\n"))
		require.NoError(t, err)

		_, err = engine.ParseAndExtract(ctx, "cpp", []byte("void bar() {}\n"))
		require.NoError(t, err)

		_, err = engine.ParseAndExtract(ctx, "swift", []byte("func bar() {}\n"))
		require.NoError(t, err)
	})

	t.Run("Swift inits and member calls", func(t *testing.T) {
		src := `
class Server {
    init(port: Int) {
        setup()
    }
    func start() {
        router.handle()
    }
}
`
		ast, err := engine.DebugAST("swift", []byte(src))
		require.NoError(t, err)
		t.Logf("Swift AST:\n%s", ast)

		res, err := engine.ParseAndExtract(ctx, "swift", []byte(src))
		require.NoError(t, err)
		t.Logf("Swift symbols: %+v", res.Symbols)
		t.Logf("Swift calls: %+v", res.CallSites)
	})

	t.Run("Scala member calls", func(t *testing.T) {
		src := `
object Main {
  def run(): Unit = {
    client.execute()
  }
}
`
		ast, err := engine.DebugAST("scala", []byte(src))
		require.NoError(t, err)
		t.Logf("Scala AST:\n%s", ast)

		res, err := engine.ParseAndExtract(ctx, "scala", []byte(src))
		require.NoError(t, err)
		t.Logf("Scala symbols: %+v", res.Symbols)
		t.Logf("Scala calls: %+v", res.CallSites)
	})

	t.Run("Kotlin interface, object, and calls", func(t *testing.T) {
		src := `
interface Service {
    fun process()
}

object App {
    fun run() {
        val s: Service = create()
        s.process()
    }
}
`
		ast, err := engine.DebugAST("kotlin", []byte(src))
		require.NoError(t, err)
		t.Logf("Kotlin AST:\n%s", ast)

		res, err := engine.ParseAndExtract(ctx, "kotlin", []byte(src))
		require.NoError(t, err)
		t.Logf("Kotlin symbols: %+v", res.Symbols)
		t.Logf("Kotlin calls: %+v", res.CallSites)

		names := make(map[string]bool)
		for _, s := range res.Symbols {
			names[s.Name] = true
		}
		assert.True(t, names["Service"], "expected interface Service, got: %+v", res.Symbols)
		assert.True(t, names["process"], "expected function process, got: %+v", res.Symbols)
		assert.True(t, names["App"], "expected object App, got: %+v", res.Symbols)
		assert.True(t, names["run"], "expected function run, got: %+v", res.Symbols)

		calls := make(map[string]bool)
		for _, c := range res.CallSites {
			calls[c.Name] = true
		}
		assert.True(t, calls["create"], "expected call site 'create'")
		assert.True(t, calls["process"], "expected call site 'process'")
	})

	t.Run("Dart constructors and factory", func(t *testing.T) {
		src := `
class UserModel {
  String name;
  UserModel(this.name);
  UserModel.named(this.name);
  factory UserModel.create() => UserModel("test");
}
`
		ast, err := engine.DebugAST("dart", []byte(src))
		require.NoError(t, err)
		t.Logf("Dart AST:\n%s", ast)

		res, err := engine.ParseAndExtract(ctx, "dart", []byte(src))
		require.NoError(t, err)
		names := make(map[string]bool)
		for _, s := range res.Symbols {
			names[s.Name] = true
		}
		assert.True(t, names["UserModel"], "expected UserModel class")
		assert.True(t, names["named"], "expected named constructor")
		assert.True(t, names["create"], "expected factory constructor")
	})

	t.Run("CSharp local functions and records", func(t *testing.T) {
		src := `
public class Worker {
    public void Process() {
        void StepOne() {}
        StepOne();
    }
}
public record Person(string Name);
`
		ast, err := engine.DebugAST("csharp", []byte(src))
		require.NoError(t, err)
		t.Logf("CSharp AST:\n%s", ast)

		res, err := engine.ParseAndExtract(ctx, "csharp", []byte(src))
		require.NoError(t, err)
		names := make(map[string]bool)
		for _, s := range res.Symbols {
			names[s.Name] = true
		}
		assert.True(t, names["Worker"], "expected Worker class")
		assert.True(t, names["Process"], "expected Process method")
		assert.True(t, names["StepOne"], "expected StepOne local function")
		assert.True(t, names["Person"], "expected Person record")

		calls := make(map[string]bool)
		for _, c := range res.CallSites {
			calls[c.Name] = true
		}
		assert.True(t, calls["StepOne"], "expected call to StepOne")
	})

	t.Run("Elixir protocols and implementations", func(t *testing.T) {
		src := `
defprotocol Deserializable do
  def deserialize(data)
end

defimpl Deserializable, for: BitString do
  def deserialize(data), do: data
end
`
		ast, err := engine.DebugAST("elixir", []byte(src))
		require.NoError(t, err)
		t.Logf("Elixir AST:\n%s", ast)

		res, err := engine.ParseAndExtract(ctx, "elixir", []byte(src))
		require.NoError(t, err)

		names := make(map[string]bool)
		for _, s := range res.Symbols {
			names[s.Name] = true
		}
		assert.True(t, names["Deserializable"], "expected Deserializable protocol")
		assert.True(t, names["deserialize"], "expected deserialize function")
	})

	t.Run("Ruby methods with punctuation", func(t *testing.T) {
		src := `
class User
  def valid?
    logger.info("checking")
    check_status()
  end

  def save!
    puts "saving"
    persist()
  end
end
`
		ast, err := engine.DebugAST("ruby", []byte(src))
		require.NoError(t, err)
		t.Logf("Ruby AST:\n%s", ast)

		res, err := engine.ParseAndExtract(ctx, "ruby", []byte(src))
		require.NoError(t, err)

		names := make(map[string]bool)
		for _, s := range res.Symbols {
			names[s.Name] = true
		}
		assert.True(t, names["User"], "expected User class")
		assert.True(t, names["valid?"], "expected valid? method, got: %+v", res.Symbols)
		assert.True(t, names["save!"], "expected save! method, got: %+v", res.Symbols)

		calls := make(map[string]bool)
		for _, c := range res.CallSites {
			calls[c.Name] = true
		}
		assert.True(t, calls["check_status"], "expected call site check_status")
		assert.True(t, calls["persist"], "expected call site persist")
		assert.True(t, calls["info"], "expected call site info")
		assert.True(t, calls["puts"], "expected call site puts")
	})
}

func TestImportExtraction(t *testing.T) {
	ctx := context.Background()
	engine, err := NewEngine(ctx)
	require.NoError(t, err)
	defer engine.Close()

	t.Run("TypeScript multiline import and bindings", func(t *testing.T) {
		src := `
import defaultMember, {
    namedA,
    namedB as aliasB,
} from "./my-service";
import './side-effect';
`
		res, err := engine.ParseAndExtract(ctx, "tsx", []byte(src))
		require.NoError(t, err)
		require.NotNil(t, res)

		require.Len(t, res.Imports, 2)
		assert.Equal(t, "./my-service", res.Imports[0].Module)
		assert.Contains(t, res.Imports[0].Bindings, "defaultMember")
		assert.Contains(t, res.Imports[0].Bindings, "namedA")
		assert.Contains(t, res.Imports[0].Bindings, "namedB")
		assert.Equal(t, "./side-effect", res.Imports[1].Module)
	})

	t.Run("Python imports and from-imports", func(t *testing.T) {
		src := `
import os
from math import sqrt, pi
`
		res, err := engine.ParseAndExtract(ctx, "python", []byte(src))
		require.NoError(t, err)
		require.NotNil(t, res)

		require.Len(t, res.Imports, 2)
		assert.Equal(t, "os", res.Imports[0].Module)
		assert.Equal(t, "math", res.Imports[1].Module)
		assert.Contains(t, res.Imports[1].Bindings, "sqrt")
		assert.Contains(t, res.Imports[1].Bindings, "pi")
	})

	t.Run("Go single and block imports", func(t *testing.T) {
		src := `package main
import "fmt"
import (
	"net/http"
	"sync"
)
`
		res, err := engine.ParseAndExtract(ctx, "go", []byte(src))
		require.NoError(t, err)
		require.NotNil(t, res)

		require.Len(t, res.Imports, 3)
		assert.Equal(t, "fmt", res.Imports[0].Module)
		assert.Equal(t, "net/http", res.Imports[1].Module)
		assert.Equal(t, "sync", res.Imports[2].Module)
	})

	t.Run("Rust use declaration", func(t *testing.T) {
		src := `
use std::collections::HashMap;
`
		res, err := engine.ParseAndExtract(ctx, "rust", []byte(src))
		require.NoError(t, err)
		require.NotNil(t, res)

		require.NotEmpty(t, res.Imports)
		assert.Equal(t, "std::collections::HashMap", res.Imports[0].Module)
	})
}
